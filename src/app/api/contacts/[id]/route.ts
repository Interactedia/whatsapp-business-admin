// Legacy global contact writes removed.
// All contact write operations are now tenant-scoped:
// POST /api/tenants/:tenantId/contacts
// PATCH /api/tenants/:tenantId/contacts/:contactId
// DELETE /api/tenants/:tenantId/contacts/:contactId

export {};
