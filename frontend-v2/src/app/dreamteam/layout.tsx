import type { ReactNode } from "react";
import PageHeader from "@/components/PageHeader";

export default function DreamTeamLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader />
      {children}
    </>
  );
}
