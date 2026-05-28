'use client';

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { useCallback } from 'react';
import { Link as WouterLink, useLocation } from 'wouter';

interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children: ReactNode;
}

export function AppLink({ href, children, onClick, ...props }: AppLinkProps) {
  return (
    <WouterLink href={href} asChild>
      <a
        {...props}
        onClick={(event) => {
          onClick?.(event);
        }}
      >
        {children}
      </a>
    </WouterLink>
  );
}

export function useAppRouter() {
  const [, navigate] = useLocation();

  const push = useCallback(
    (href: string) => {
      void navigate(href);
    },
    [navigate]
  );

  const replace = useCallback(
    (href: string) => {
      void navigate(href, { replace: true });
    },
    [navigate]
  );

  const prefetch = useCallback((_href: string) => {
    // No-op under the SPA runtime; kept for API compatibility with existing UI.
  }, []);

  return {
    push,
    replace,
    prefetch,
  };
}
