import type { ReactNode } from "react";
import PageHeader from "@/components/PageHeader";

export default function CloudFFLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader />
      {children}
    </>
  );
}
