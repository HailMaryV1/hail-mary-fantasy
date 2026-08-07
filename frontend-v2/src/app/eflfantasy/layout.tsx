import type { ReactNode } from "react";
import PageHeader from "@/components/PageHeader";

export default function EFLFantasyLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader />
      {children}
    </>
  );
}
