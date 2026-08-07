import type { ReactNode } from "react";
import PageHeader from "@/components/PageHeader";

export default function GolfLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader />
      {children}
    </>
  );
}
