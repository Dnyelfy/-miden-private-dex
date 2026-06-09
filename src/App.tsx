import { AppProviders } from "@/providers";
import { AppContent } from "@/components/AppContent";

export default function App() {
  return (
    <AppProviders>
      <AppContent />
    </AppProviders>
  );
}
