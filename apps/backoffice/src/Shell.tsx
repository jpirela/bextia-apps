import { useState, type ReactNode } from "react";
import { Shell as LaraShell, type NavSection } from "krypton-ecosystem/lara/fluent";
import { HiOutlineArrowUpTray, HiOutlineChartBar, HiOutlineChatBubbleLeftRight, HiOutlineCog6Tooth, HiOutlineExclamationTriangle, HiOutlineSquares2X2, HiOutlineUsers } from "react-icons/hi2";
import { navFor, type Role } from "./lib/roles";
import { session } from "./lib/client";

const ICONS: Record<string, ReactNode> = {
  dashboard: <HiOutlineChartBar />, leads: <HiOutlineUsers />, incidents: <HiOutlineExclamationTriangle />,
  config: <HiOutlineCog6Tooth />, import: <HiOutlineArrowUpTray />, simulator: <HiOutlineChatBubbleLeftRight />,
};

// El filtrado por rol es solo de navegación: la API es la que autoriza.
export function Shell({ role, email, pages }: { role: Role; email: string; pages: Record<string, () => ReactNode> }) {
  const nav = navFor(role);
  const [current, setCurrent] = useState(nav[0]?.key ?? "");
  const sections: NavSection[] = [{
    id: "backoffice", label: "Backoffice", icon: <HiOutlineSquares2X2 />,
    items: nav.map((n) => ({ id: n.key, label: n.label, icon: ICONS[n.key] ?? null })),
  }];
  return (
    <LaraShell
      sections={sections}
      activeId={current}
      onNavigate={setCurrent}
      brand="BEXTIA"
      user={{ name: email, role, initials: (email[0] ?? "?").toUpperCase() }}
      onLogout={() => { void session.logout(); }}
    >
      {pages[current]?.()}
    </LaraShell>
  );
}


