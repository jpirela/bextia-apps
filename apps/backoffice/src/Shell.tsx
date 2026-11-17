import { useEffect, useState, type ReactNode } from "react";
import { Shell as LaraShell, type NavSection } from "krypton-ecosystem/lara/fluent";
import { HiOutlineArrowUpTray, HiOutlineChartBar, HiOutlineChatBubbleLeftRight, HiOutlineCog6Tooth, HiOutlineExclamationTriangle, HiOutlineSquares2X2, HiOutlineUsers } from "react-icons/hi2";
import { navFor, type Role } from "./lib/roles";
import { session } from "./lib/client";
import type { DeepLink } from "./lib/deeplink";

const ICONS: Record<string, ReactNode> = {
  dashboard: <HiOutlineChartBar />, leads: <HiOutlineUsers />, incidents: <HiOutlineExclamationTriangle />,
  config: <HiOutlineCog6Tooth />, import: <HiOutlineArrowUpTray />, simulator: <HiOutlineChatBubbleLeftRight />,
};

// El filtrado por rol es solo de navegación: la API es la que autoriza.
export function Shell({ role, email, pages, link = null }: { role: Role; email: string; pages: Record<string, (initialId?: string) => ReactNode>; link?: DeepLink | null }) {
  const nav = navFor(role);
  const allowed = link && nav.some((n) => n.key === link.page) ? link : null;
  const [current, setCurrent] = useState(allowed?.page ?? nav[0]?.key ?? "");
  const [linkId, setLinkId] = useState(allowed?.id);
  // Enlace consumido: se limpia la URL (también si el rol no tenía acceso a esa sección).
  useEffect(() => { if (link) window.history.replaceState(null, "", "/"); }, [link]);
  const sections: NavSection[] = [{
    id: "backoffice", label: "Backoffice", icon: <HiOutlineSquares2X2 />,
    items: nav.map((n) => ({ id: n.key, label: n.label, icon: ICONS[n.key] ?? null })),
  }];
  return (
    <LaraShell
      sections={sections}
      activeId={current}
      onNavigate={(k) => { setLinkId(undefined); setCurrent(k); }}
      brand="BEXTIA"
      user={{ name: email, role, initials: (email[0] ?? "?").toUpperCase() }}
      onLogout={() => { void session.logout(); }}
    >
      {pages[current]?.(current === allowed?.page ? linkId : undefined)}
    </LaraShell>
  );
}

