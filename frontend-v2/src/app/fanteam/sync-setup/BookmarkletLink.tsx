"use client";

import { useEffect, useRef } from "react";

/**
 * React 19 deliberately blocks any `javascript:` URL passed through JSX's
 * href prop (a built-in XSS precaution - see facebook/react#26507) by
 * swapping it for a stub that throws. That protection is implemented in
 * JSX's own attribute-diffing path, not at the DOM API level, so setting
 * the attribute imperatively via a ref after mount (this component's only
 * job) isn't intercepted - the only way to render a real bookmarklet link
 * at all. This is app-generated content (the bookmarklet source lives in
 * this repo, not user input), so the thing the block exists to prevent
 * doesn't apply here.
 */
export default function BookmarkletLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    ref.current?.setAttribute("href", href);
  }, [href]);

  return (
    <a ref={ref} draggable className={className}>
      {children}
    </a>
  );
}
