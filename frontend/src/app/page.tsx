import { Workbench } from "@/components/Workbench";
import { ToastProvider } from "@/components/ui";

export default function Home() {
  return (
    <ToastProvider>
      <Workbench />
    </ToastProvider>
  );
}
