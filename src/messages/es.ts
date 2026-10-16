/**
 * Spanish (default locale) UI messages.
 * The `as const` + derived `MessageKey` type makes every key compile-time
 * checked: `en.ts` must provide the exact same set of keys.
 */
export const es = {
  // Navigation items (labels rendered in the sidebar)
  "nav.dashboard": "Dashboard",
  "nav.inbox": "Inbox",
  "nav.contacts": "Contacts",
  "nav.templates": "Templates",
  "nav.flows": "Flows",
  "nav.submissions": "Submissions",
  "nav.broadcasts": "Broadcasts",
  "nav.settings": "Settings",
  "nav.webhooks": "Webhooks salientes",
  "nav.api": "API",
  "nav.users": "Users",
  "nav.queues": "Queues",
  "nav.logs": "Logs",
  "nav.tenants": "Tenants",
  "nav.adminDashboard": "Dashboard",

  // Navigation group headers
  "group.principal": "Principal",
  "group.atencion": "Atención",
  "group.campanas": "Campañas y automatización",
  "group.administracion": "Administración",

  // User / profile menu
  "shell.logout": "Cerrar sesión",
  "shell.language": "Idioma",
  "shell.spanish": "Español",
  "shell.english": "English",

  // Shell status & chrome
  "shell.connected": "Connected",
  "shell.notConnected": "Not connected",
  "shell.businessConsole": "Business Console",
  "shell.controlPanel": "Control Panel",
  "shell.systemAdministration": "System Administration",
  "shell.platformWideAccess": "Platform-wide access",

  // Accessibility labels
  "shell.userMenu": "User menu",
  "shell.openNavigation": "Open navigation",
  "shell.closeNavigation": "Close navigation",
  "shell.navigation": "Navigation",
} as const;

export type MessageKey = keyof typeof es;
