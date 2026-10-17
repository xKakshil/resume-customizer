"""Deterministic keyword extraction and JD↔resume matching.

The match score is computed *without* the LLM on purpose:
- it is reproducible (same inputs → same score), so before/after comparisons are fair;
- it can't be gamed by the model claiming a high score;
- every point is explainable: the UI shows exactly which keywords matched.

Keywords come from a curated skills lexicon (with aliases such as
"k8s"→Kubernetes, "postgres"→PostgreSQL) plus uncommon acronyms found in the JD
(e.g. SOC2, HIPAA). Each keyword is weighted by category, by how often the JD
repeats it, and by whether it appears in a "required / must have" context.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

# "canonical|alias|alias" — matching is case-insensitive with smart boundaries.
_LEXICON: dict[str, list[str]] = {
    "language": [
        "Python", "Java", "JavaScript|JS|ECMAScript|ES6", "TypeScript|TS", "C++|cpp", "C#|csharp", "C",
        "=Go|Golang", "=Rust", "Kotlin", "=Swift", "Objective-C", "=Ruby", "PHP", "Scala", "R", "MATLAB",
        "=Dart", "=Elixir", "Haskell", "=Perl", "=Lua", "=Julia", "Solidity", "Bash|Shell scripting", "PowerShell",
        "SQL", "PL/SQL", "T-SQL", "HTML|HTML5", "CSS|CSS3", "Sass|SCSS", "GraphQL", "Verilog", "VHDL", "Assembly",
    ],
    "frontend": [
        "React|React.js|ReactJS", "Next.js|NextJS", "Vue|Vue.js|VueJS", "Nuxt|Nuxt.js", "Angular|AngularJS",
        "Svelte|SvelteKit", "Redux|Redux Toolkit", "Zustand", "React Query|TanStack Query", "Tailwind|Tailwind CSS|TailwindCSS",
        "Bootstrap", "Material UI|MUI", "Chakra UI", "shadcn/ui|shadcn", "jQuery", "Webpack", "Vite", "Babel",
        "React Native", "Flutter", "=Expo", "Three.js", "D3.js|D3", "Storybook", "Responsive design",
        "Accessibility|a11y|WCAG", "Server-side rendering|SSR", "Web performance|Core Web Vitals",
    ],
    "backend": [
        "Node.js|NodeJS|=Node", "=Express|Express.js|ExpressJS", "NestJS|Nest.js", "Fastify", "Deno", "=Bun",
        "Django", "Flask", "FastAPI", "Spring Boot|=Spring", "Hibernate", ".NET|dotnet|ASP.NET|.NET Core",
        "Ruby on Rails|=Rails", "Laravel", "=Gin", "REST API|RESTful|REST APIs|=REST", "gRPC", "WebSockets|WebSocket|Socket.io",
        "Microservices|microservice", "Event-driven architecture|event-driven", "Serverless", "API design",
        "Authentication|OAuth|OAuth2|JWT|SSO", "Celery", "BullMQ", "Message queues|message queue",
    ],
    "data": [
        "PostgreSQL|Postgres", "MySQL", "MariaDB", "SQLite", "MongoDB|Mongo", "Redis", "Cassandra", "DynamoDB",
        "Elasticsearch|OpenSearch", "Firebase|Firestore", "Supabase", "Oracle", "SQL Server|MSSQL", "Snowflake",
        "BigQuery", "Redshift", "Databricks", "ClickHouse", "Neo4j", "Prisma", "Sequelize", "Mongoose", "SQLAlchemy",
        "TypeORM", "Kafka|Apache Kafka", "RabbitMQ", "=Spark|Apache Spark|PySpark", "Hadoop", "Airflow|Apache Airflow",
        "dbt", "ETL|ELT", "Data pipelines|data pipeline", "Data modeling|data modelling", "Data warehousing|data warehouse",
        "Pandas", "NumPy", "=Excel|MS Excel|Advanced Excel", "Power BI|PowerBI", "Tableau", "Looker", "Statistics|statistical analysis",
        "A/B testing|AB testing|experimentation", "Database design", "Query optimization", "Caching",
    ],
    "ai_ml": [
        "Machine Learning|ML", "Deep Learning|DL", "NLP|Natural Language Processing", "Computer Vision",
        "LLM|LLMs|Large Language Models", "Generative AI|GenAI|Gen AI", "RAG|Retrieval-Augmented Generation|retrieval augmented generation",
        "Prompt engineering", "LangChain", "LlamaIndex", "OpenAI API|OpenAI", "=Gemini", "Hugging Face|HuggingFace|Transformers",
        "PyTorch", "TensorFlow", "Keras", "scikit-learn|sklearn", "XGBoost", "OpenCV", "Vector databases|vector database|vector DB",
        "Pinecone", "FAISS", "ChromaDB|=Chroma", "pgvector", "Embeddings|vector embeddings", "Fine-tuning|fine tuning", "MLOps", "AI agents|agentic|LLM agents",
        "Speech recognition|ASR|speech-to-text", "Text-to-speech|TTS", "Recommendation systems|recommender systems",
    ],
    "cloud_devops": [
        "AWS|Amazon Web Services", "EC2", "S3", "=Lambda|AWS Lambda", "ECS", "EKS", "CloudFormation", "GCP|Google Cloud|Google Cloud Platform",
        "Cloud Run", "Azure|Microsoft Azure", "Docker|containers|containerization", "Kubernetes|k8s", "=Helm", "Terraform", "Ansible",
        "CI/CD|CICD|continuous integration|continuous deployment", "GitHub Actions", "Jenkins", "GitLab CI", "CircleCI", "ArgoCD",
        "Linux|Unix", "Nginx", "=Apache", "Vercel", "Netlify", "=Render", "Heroku", "Cloudflare", "Prometheus", "Grafana",
        "Datadog", "New Relic", "ELK", "Observability|monitoring", "Logging|log aggregation", "Load balancing|load balancer", "CDN",
        "Infrastructure as Code|IaC", "SRE|Site Reliability", "DevOps",
    ],
    "practice": [
        "Git", "GitHub", "GitLab", "Bitbucket", "Jira", "Confluence", "Agile", "Scrum", "Kanban", "TDD|test-driven development",
        "Unit testing|unit tests", "Integration testing|integration tests", "E2E testing|end-to-end testing|end-to-end tests", "Jest",
        "Vitest", "Mocha", "Cypress", "Playwright", "Selenium", "Pytest", "JUnit", "Postman", "Swagger|OpenAPI",
        "Code review|code reviews", "System design", "Distributed systems", "Scalability|scalable", "High availability",
        "Performance optimization|performance tuning", "Design patterns", "OOP|object-oriented programming|object oriented",
        "Functional programming", "Data structures", "Algorithms", "DSA", "Multithreading|concurrency", "Debugging",
        "Application security|AppSec|web security", "OWASP", "Encryption", "Networking|TCP/IP", "Operating systems|=OS",
        "DBMS", "Embedded systems|embedded", "IoT|Internet of Things", "Microcontrollers|Arduino|ESP32|STM32", "Raspberry Pi",
        "PCB design", "Signal processing|DSP", "FPGA", "Figma", "UI/UX|UX|user experience", "SEO", "Web scraping",
        "Mobile development|mobile apps|mobile app", "Android", "iOS", "Full stack|full-stack|fullstack", "Frontend|front-end|front end",
        "Backend|back-end|back end", "Product management", "Documentation|technical writing",
    ],
    "soft": [
        "Communication|communication skills", "Leadership", "Mentoring|mentorship", "Collaboration|cross-functional",
        "Problem solving|problem-solving", "Ownership", "Stakeholder management|stakeholders", "Time management",
        "Analytical skills", "Attention to detail", "Teamwork|team player", "Presentation skills", "Negotiation",
        "Project management", "Customer focus|customer-facing|client-facing", "Startup experience|fast-paced",
    ],
}

_CATEGORY_WEIGHT = {
    "language": 3.0, "frontend": 3.0, "backend": 3.0, "data": 3.0, "ai_ml": 3.0,
    "cloud_devops": 3.0, "practice": 2.0, "soft": 1.0, "acronym": 1.5,
}

# Acronyms that are everywhere in JDs but say nothing about the role.
_ACRONYM_STOP = {
    "US", "USA", "UK", "IT", "HR", "CEO", "CTO", "COO", "CFO", "VP", "EOE", "EEO", "AND", "OR", "THE", "WFH", "PTO",
    "INR", "USD", "LPA", "CTC", "PM", "AM", "IST", "PST", "EST", "FAQ", "TBD", "ASAP", "NA", "N/A", "OK", "ID", "PDF",
    "DOCX", "B2B", "B2C", "SAAS", "SaaS", "KPI", "KPIS", "MVP", "ROI", "Q1", "Q2", "Q3", "Q4", "BE", "BTECH", "MTECH",
    "ME", "MS", "BS", "MBA", "PHD", "CGPA", "GPA", "YOE", "NOTE", "AI", "API", "APIS", "UI", "JD", "ESOP", "ESOPS", "LLC",
    "PVT", "LTD", "INC", "AWS", "SQL", "ML", "NLP", "CV", "OS", "IOT", "UX", "SEO", "SRE", "DSA", "OOP", "TDD", "ETL",
    "CI", "CD", "REST", "JWT", "SSO", "RAG", "LLM", "LLMS", "DSP", "DBMS", "GCP", "ELK", "CDN", "IAC", "ASR", "TTS",
    "HTML", "CSS", "JS", "TS", "PHP", "SSR", "MUI", "ORM",
}

_REQUIRED_CUES = re.compile(r"\b(required|requirements?|must[- ]have|must|mandatory|minimum|qualifications?|you have|you bring|strong (knowledge|experience|proficiency))\b", re.I)


@dataclass(frozen=True)
class Keyword:
    name: str
    category: str
    pattern: re.Pattern


@dataclass
class WeightedKeyword:
    name: str
    category: str
    weight: float
    required: bool
    jd_count: int

    def to_dict(self) -> dict:
        return {"keyword": self.name, "category": self.category, "weight": round(self.weight, 2),
                "required": self.required, "jd_count": self.jd_count}


def _alias_regex(alias: str) -> str:
    # Words separated by spaces may be joined by spaces/hyphens; hyphens are optional ("end-to-end" ≈ "end to end").
    parts = re.split(r"(\s+|-)", alias.strip())
    rx = "".join(r"[\s\-]+" if p.isspace() else r"[\s\-]?" if p == "-" else re.escape(p) for p in parts if p)
    # Word-ish boundaries that also work for C++, C#, .NET, Node.js ...
    return rf"(?<![\w.+#/]){rx}(?![\w+#]|\.\w)"


@lru_cache
def lexicon() -> tuple[Keyword, ...]:
    """Compile the lexicon. Aliases prefixed with '=' and very short alphabetic
    aliases (C, R, ML, UX…) are case-sensitive, because their lowercase forms
    are ordinary English ("rest", "go", "excel", "spark")."""
    out: list[Keyword] = []
    for category, entries in _LEXICON.items():
        for entry in entries:
            names = entry.split("|")
            canonical = names[0].lstrip("=")
            parts = []
            for n in names:
                sensitive = n.startswith("=") or (len(n) <= 2 and n.isalpha())
                rx = _alias_regex(n.lstrip("="))
                parts.append(rx if sensitive else f"(?i:{rx})")
            out.append(Keyword(canonical, category, re.compile("|".join(parts))))
    return tuple(out)


def _count(pattern: re.Pattern, text: str) -> int:
    return len(pattern.findall(text))


def _ambiguous_hit(kw: Keyword, text: str) -> bool:
    """Extra context checks for single-letter language names."""
    if kw.name == "C":
        return bool(re.search(r"(?<![\w.+#])C(?=\s*(/|,|\s+programming|\s+language|\s+and\s+C\+\+))|\bC/C\+\+|,\s*C\s*(,|$)", text, re.M))
    if kw.name == "R":
        return bool(re.search(r"(?<![\w.+#-])R(?=\s*(,|/|\s+programming|\s+language|\s+and\b))|,\s*R\s*(,|\.|$)", text, re.M))
    if kw.name == "Go":
        return bool(re.search(r"\bGolang\b|\bGo\s*(,|/|\(|lang\b|developer|programming)|\bin\s+Go\b|,\s*Go\b", text))
    return True


def extract_jd_keywords(jd: str, max_acronyms: int = 8) -> list[WeightedKeyword]:
    lines = [l for l in jd.splitlines() if l.strip()]
    required_text = "\n".join(l for i, l in enumerate(lines) if _REQUIRED_CUES.search(l) or any(_REQUIRED_CUES.search(x) for x in lines[max(0, i - 4):i] if len(x) < 60))
    found: dict[str, WeightedKeyword] = {}

    for kw in lexicon():
        n = _count(kw.pattern, jd)
        if n == 0 or not _ambiguous_hit(kw, jd):
            continue
        required = bool(kw.pattern.search(required_text))
        weight = _CATEGORY_WEIGHT[kw.category] * (1.5 if required else 1.0) * (1 + 0.25 * min(n - 1, 2))
        found[kw.name.lower()] = WeightedKeyword(kw.name, kw.category, weight, required, n)

    # Uncommon acronyms (SOC2, HIPAA, PCI-DSS, GDPR, …) the lexicon doesn't know about.
    acronyms: dict[str, int] = {}
    for m in re.finditer(r"(?<![\w/+#.])([A-Z][A-Z0-9&\-]{1,9}[A-Z0-9])(?![\w/+#])", jd):
        token = m.group(1)
        if token.upper() in _ACRONYM_STOP or token.lower() in found or token.isdigit():
            continue
        if any(kw.pattern.fullmatch(token) for kw in lexicon()):
            continue
        if re.fullmatch(r"[A-Z]{1,4}-\d{1,2}", token):  # job levels like SDE-1, L-5
            continue
        acronyms[token] = acronyms.get(token, 0) + 1
    for token, n in sorted(acronyms.items(), key=lambda x: -x[1])[:max_acronyms]:
        if len(token) < 3 and n < 2:
            continue
        found[token.lower()] = WeightedKeyword(token, "acronym", _CATEGORY_WEIGHT["acronym"] * (1 + 0.25 * min(n - 1, 2)), False, n)

    # Drop keywords that only appear inside a longer one ("GitHub" within "GitHub Actions").
    names = list(found)
    for short in names:
        for long in names:
            if short != long and short in long and found[short].jd_count <= found[long].jd_count and short in found:
                found.pop(short)
                break

    return sorted(found.values(), key=lambda k: -k.weight)


def keyword_present(name: str, text: str) -> bool:
    for kw in lexicon():
        if kw.name.lower() == name.lower():
            return bool(kw.pattern.search(text)) and _ambiguous_hit(kw, text)
    return bool(re.search(rf"(?<![\w]){re.escape(name)}(?![\w])", text, re.I))


def match_score(jd_keywords: list[WeightedKeyword], resume_text: str) -> dict:
    if not jd_keywords:
        return {"score": None, "matched": [], "missing": [], "total": 0,
                "note": "No recognisable skills or technologies were found in the job description."}
    matched, missing = [], []
    got = total = 0.0
    for kw in jd_keywords:
        total += kw.weight
        if keyword_present(kw.name, resume_text):
            got += kw.weight
            matched.append(kw.to_dict())
        else:
            missing.append(kw.to_dict())
    return {"score": round(100 * got / total) if total else 0, "matched": matched, "missing": missing, "total": len(jd_keywords)}


def resume_skills(text: str) -> set[str]:
    """Canonical lexicon skills present anywhere in a text (used by the truthfulness guard)."""
    return {kw.name.lower() for kw in lexicon() if kw.pattern.search(text) and _ambiguous_hit(kw, text)}
