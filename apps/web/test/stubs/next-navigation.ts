/**
 * Test stand-in for next/navigation (test/register.mjs maps it). The router is a no-op; a test
 * sets the path and the query string a component reads with setPathname / setSearch.
 */
let pathname = "/";
let search = "";

export function setPathname(p: string): void {
  pathname = p;
}

export function setSearch(s: string): void {
  search = s;
}

const router = {
  push(_href: string): void {},
  replace(_href: string, _opts?: { scroll?: boolean }): void {},
  refresh(): void {},
  back(): void {},
  forward(): void {},
  prefetch(_href: string): void {},
};

export function useRouter() {
  return router;
}

export function usePathname(): string {
  return pathname;
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(search);
}
