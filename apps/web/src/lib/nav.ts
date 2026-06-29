/**
 * Whether a nav link is the active route, shared by the sidebar and the mobile nav so the highlight
 * logic lives in one tested place. Pure (takes the pathname rather than reading `$page`), so the
 * Sessions-link special case — active on the dashboard AND any `/sessions/...` detail page — is unit-tested.
 */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/sessions');
  return pathname === href || pathname.startsWith(`${href}/`);
}
