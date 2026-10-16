import type { MessageKey } from "./es";

/**
 * English UI messages. Typed against the Spanish dictionary so a missing
 * or extra key is a compile-time error, never a runtime hole.
 */
export const en: Record<MessageKey, string> = {
  // Navigation items
  "nav.dashboard": "Dashboard",
  "nav.inbox": "Inbox",
  "nav.contacts": "Contacts",
  "nav.templates": "Templates",
  "nav.flows": "Flows",
  "nav.submissions": "Submissions",
  "nav.broadcasts": "Broadcasts",
  "nav.settings": "Settings",
  "nav.webhooks": "Outgoing webhooks",
  "nav.api": "API",
  "nav.users": "Users",
  "nav.queues": "Queues",
  "nav.logs": "Logs",
  "nav.tenants": "Tenants",
  "nav.adminDashboard": "Dashboard",

  // Navigation group headers
  "group.principal": "Main",
  "group.atencion": "Support",
  "group.campanas": "Campaigns & automation",
  "group.administracion": "Administration",

  // User / profile menu
  "shell.logout": "Sign out",
  "shell.language": "Language",
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
};
