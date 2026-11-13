import { type ReactNode, useEffect, useRef } from "react";

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-full max-w-md rounded-xl border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/40"
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-semibold">{title}</h2>
        {children}
        {footer === undefined ? null : <div className="flex justify-end gap-2">{footer}</div>}
      </div>
    </dialog>
  );
}
