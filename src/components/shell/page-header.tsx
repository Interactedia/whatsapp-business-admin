// ponytail: default = 24px title (page header), compact = 14px (section header)
export function PageHeader({
  title,
  description,
  actions,
  size = "default",
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  size?: "default" | "compact";
}) {
  // Standard page header: 24px title, 14px description, generous padding
  const titleClass = size === "compact"
    ? "text-sm font-semibold"
    : "text-2xl font-semibold tracking-tight text-foreground";
  const descriptionClass = size === "compact"
    ? "text-xs text-muted-foreground"
    : "mt-1 text-sm leading-relaxed text-muted-foreground";
  // Consistent padding: 16px mobile, 24px desktop, ~20px vertical
  const containerClass = size === "compact"
    ? "flex flex-col gap-2 border-b bg-card px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-4 sm:py-2.5"
    : "flex flex-col gap-2 border-b bg-card px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-6 sm:py-5";

  return (
    <div className={containerClass}>
      <div className="min-w-0">
        <h1 className={titleClass}>{title}</h1>
        {description && <p className={descriptionClass}>{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
