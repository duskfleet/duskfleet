"use client";

import { useEffect } from "react";

/**
 * Marks the table-of-contents link whose target is the last one scrolled past the top of the
 * viewport with aria-current="location". Renders nothing: the links stay server-rendered.
 */
export function TocSpy({ selector }: { selector: string }) {
  useEffect(() => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(`${selector} a[href^="#"]`));
    const pairs = links
      .map((a) => ({ a, el: document.getElementById(decodeURIComponent(a.hash.slice(1))) }))
      .filter((p): p is { a: HTMLAnchorElement; el: HTMLElement } => p.el !== null);
    if (pairs.length === 0) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      let current = pairs[0]!;
      for (const p of pairs) {
        if (p.el.getBoundingClientRect().top <= 96) current = p;
        else break;
      }
      // At the bottom of the page the last entries can never reach the top: take the last one.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = pairs[pairs.length - 1]!;
      for (const p of pairs) {
        if (p === current) p.a.setAttribute("aria-current", "location");
        else p.a.removeAttribute("aria-current");
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [selector]);
  return null;
}
