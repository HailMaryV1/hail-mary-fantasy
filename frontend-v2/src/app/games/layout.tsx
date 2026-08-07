import type { ReactNode } from "react";
import PageHeader from "@/components/PageHeader";

export default function GamesLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader />
      {children}
    </>
  );
}
