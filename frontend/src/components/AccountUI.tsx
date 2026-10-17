"use client";

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { ApiError, auth, history as historyApi } from "@/lib/api";
import type { HistoryItem, User } from "@/lib/types";
import { timeAgo } from "@/lib/resume";
import { Button, Dialog, Drawer, Spinner, cx, useToast } from "./ui";

export function AuthDialog({ open, onClose, onAuthed }: { open: boolean; onClose: () => void; onAuthed: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Use at least 8 characters for your password.");
    setBusy(true);
    try {
      const res = mode === "login" ? await auth.login(email, password) : await auth.register(email, password, name);
      onAuthed(res.token, res.user);
      setPassword("");
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={mode === "login" ? "Sign in" : "Create an account"}>
      <p className="-mt-2 mb-4 text-sm text-muted">Signed-in users get every tailored resume saved to their history, across devices.</p>
      <form onSubmit={submit} className="space-y-3">
        {mode === "register" && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} className="h-10 w-full rounded-lg border border-rule bg-paper px-3 outline-none focus:border-blue" />
          </label>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className="h-10 w-full rounded-lg border border-rule bg-paper px-3 outline-none focus:border-blue" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className="h-10 w-full rounded-lg border border-rule bg-paper px-3 outline-none focus:border-blue"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {mode === "login" ? "Sign in" : "Create account"}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted">
        {mode === "login" ? "New here? " : "Already have an account? "}
        <button
          className="font-medium text-blue hover:underline"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Create an account" : "Sign in"}
        </button>
      </p>
    </Dialog>
  );
}

export function HistoryDrawer({ open, onClose, onOpenRun }: { open: boolean; onClose: () => void; onOpenRun: (id: number) => Promise<void> }) {
  const toast = useToast();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  // The drawer is mounted only while open, so this runs once per opening.
  useEffect(() => {
    let alive = true;
    historyApi
      .list()
      .then((x) => alive && setItems(x))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const remove = async (id: number) => {
    try {
      await historyApi.remove(id);
      setItems((x) => x?.filter((i) => i.id !== id) ?? null);
      toast("success", "Deleted from history.");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="History">
      {error && <p className="p-5 text-sm text-red">{error}</p>}
      {!items && !error && (
        <div className="flex items-center gap-2 p-5 text-sm text-muted">
          <Spinner /> Loading…
        </div>
      )}
      {items && !items.length && <p className="p-5 text-sm text-muted">Nothing here yet. Tailored resumes are saved automatically while you&apos;re signed in.</p>}
      <ul className="divide-y divide-rule-soft">
        {items?.map((it) => (
          <li key={it.id} className="group flex items-start gap-2 px-5 py-3 hover:bg-desk/60">
            <button
              className="min-w-0 flex-1 text-left"
              onClick={async () => {
                setOpening(it.id);
                await onOpenRun(it.id);
                setOpening(null);
                onClose();
              }}
            >
              <div className="truncate font-medium">{it.title || "Tailored resume"}</div>
              <div className="truncate text-[13px] text-muted">
                {[it.company, it.resume_filename, timeAgo(it.created_at)].filter(Boolean).join(" · ")}
              </div>
              <div className="mt-0.5 text-[13px] tabular-nums text-ink-2">
                Match {it.match_before ?? "—"} → <b>{it.match_after ?? "—"}</b>
                {it.tone && <span className="ml-2 capitalize text-muted">{it.tone}</span>}
                {opening === it.id && <Spinner className="ml-2 inline" />}
              </div>
            </button>
            <button onClick={() => remove(it.id)} className={cx("rounded-md p-1.5 text-muted opacity-60 hover:bg-red-wash hover:text-red group-hover:opacity-100")} aria-label={`Delete ${it.title}`}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
