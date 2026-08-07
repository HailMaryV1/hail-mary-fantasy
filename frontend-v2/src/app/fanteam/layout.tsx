import type { ReactNode } from "react";
import PageHeader from "@/components/PageHeader";

export default function FanTeamLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader />
      {children}
    </>
  );
}
