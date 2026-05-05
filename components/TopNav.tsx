'use client';

import Link from 'next/link';
import { Zap } from 'lucide-react';

export const TOP_NAV_ACTIVE_VALUES = ['feed', 'manage', 'addresses', 'system'] as const;
export type TopNavActive = (typeof TOP_NAV_ACTIVE_VALUES)[number];
export const TOP_NAV_ITEMS = [
  { href: '/', label: 'Feed', active: 'feed' },
  { href: '/manage', label: '人物', active: 'manage' },
  { href: '/addresses', label: '地址', active: 'addresses' },
  { href: '/system', label: '系统', active: 'system' },
] as const satisfies ReadonlyArray<{
  href: string;
  label: string;
  active: TopNavActive;
}>;

interface TopNavProps {
  active: TopNavActive;
  rightSlot?: React.ReactNode;
}

function NavLink(props: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={props.href}
      className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
        props.active
          ? 'bg-zinc-800 text-zinc-100'
          : 'bg-zinc-800/50 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
      }`}
    >
      {props.label}
    </Link>
  );
}

export function TopNav({ active, rightSlot }: TopNavProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-zinc-800/50 bg-zinc-950/95 backdrop-blur-md">
      <div className="mx-auto grid h-14 w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <h1 className="truncate text-lg font-semibold text-zinc-100">Web3玩家动态</h1>
        </div>

        <div className="flex items-center justify-center gap-2">
          {TOP_NAV_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} active={active === item.active} />
          ))}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2">
          {rightSlot}
        </div>
      </div>
    </header>
  );
}
