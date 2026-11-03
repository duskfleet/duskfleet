import type { AnchorHTMLAttributes, ReactNode } from "react";

/** Test stand-in for next/link: a plain <a> with the same props (test/register.mjs maps it). */
export default function Link({
  href,
  children,
  prefetch: _prefetch,
  scroll: _scroll,
  replace: _replace,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string | { pathname?: string };
  children?: ReactNode;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
}) {
  return (
    <a href={typeof href === "string" ? href : (href.pathname ?? "")} {...rest}>
      {children}
    </a>
  );
}
