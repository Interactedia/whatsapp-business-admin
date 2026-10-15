export function PageHeader({
  title,
  description,
  actions,
  size = "default",
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  size?: "default" | "large";
}) {
  const titleClass = size === "large" ? "text-2xl font-semibold tracking-tight text-foreground" : "text-sm font-semibold";
  const descriptionClass = size === "large" ? "mt-1 text-sm leading-relaxed text-muted-foreground" : "text-xs text-muted-foreground";

  return (
    <div className="flex flex-col gap-2 border-b bg-card px-3 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-4 sm:py-2.5">
      <div className="min-w-0">
        <h1 className={titleClass}>{title}</h1>
        {description && <p className={descriptionClass}>{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
