/**
 * kimi-web-tools — Standalone UI Primitives & Artwork Icons.
 *
 * Replaces `@deepseek-ai/dsh-client-ui-primitives` with self-contained React
 * components (Button, Input, Modal, StateDot, Menu) and the 10 stroke-suffixed
 * SVG icon artworks (`Icon*OutlineRegular`) styled via `--dsw-alias-*` CSS
 * custom properties.
 * @module
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { text, surface, state as stateColor, button as buttonColor, mask, shadow } from "./theme.ts";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export interface ButtonProps {
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "outline" | "ghost" | "danger";
  icon?: ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
  title?: string;
  "aria-label"?: string;
}

export function Button(props: ButtonProps) {
  const {
    size = "md",
    variant = "outline",
    icon,
    onClick,
    disabled,
    style,
    className,
    children,
    title,
    "aria-label": ariaLabel,
  } = props;

  const height = size === "sm" ? 28 : size === "lg" ? 38 : 34;
  const fontSize = size === "sm" ? 12 : 13;
  const padding = children ? (size === "sm" ? "0 10px" : "0 14px") : size === "sm" ? "0 6px" : "0 8px";

  let bg: string = surface.layer1;
  let fg: string = text.primary;
  let border = `1px solid ${surface.border}`;

  if (variant === "primary") {
    bg = buttonColor.primaryFill;
    fg = buttonColor.primaryText;
    border = "1px solid transparent";
  } else if (variant === "ghost") {
    bg = "transparent";
    fg = text.secondary;
    border = "1px solid transparent";
  } else if (variant === "danger") {
    bg = stateColor.danger;
    fg = "#ffffff";
    border = "1px solid transparent";
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={className ? `dswt-primitive-btn ${className}` : "dswt-primitive-btn"}
      data-variant={variant}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height,
        padding,
        borderRadius: size === "sm" ? 7 : 8,
        border,
        background: bg,
        color: fg,
        fontFamily: "inherit",
        fontSize,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: "nowrap",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "background-color 120ms ease, border-color 120ms ease, opacity 120ms ease",
        boxSizing: "border-box",
        outline: "none",
        ...style,
      }}
    >
      {icon && <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>{icon}</span>}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputProps {
  value?: string;
  icon?: ReactNode;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  style?: CSSProperties;
  className?: string;
  autoFocus?: boolean;
}

export function Input(props: InputProps) {
  const {
    value,
    icon,
    onChange,
    onKeyDown,
    placeholder,
    disabled,
    type = "text",
    style,
    className,
    autoFocus,
  } = props;

  return (
    <div
      className={className}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        width: "100%",
        height: 34,
        borderRadius: 8,
        border: `1px solid ${surface.border}`,
        background: surface.layer2,
        padding: "0 10px",
        gap: 8,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {icon && (
        <span style={{ display: "inline-flex", alignItems: "center", color: text.tertiary, flexShrink: 0 }}>
          {icon}
        </span>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          border: "none",
          outline: "none",
          background: "transparent",
          color: text.primary,
          fontFamily: "inherit",
          fontSize: 13,
          padding: 0,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StateDot
// ---------------------------------------------------------------------------

export interface StateDotProps {
  state: "done" | "error" | "warn" | "warning" | "ongoing" | "idle" | "none" | string;
  size?: number;
  style?: CSSProperties;
}

export function StateDot(props: StateDotProps) {
  const { state, size = 8, style } = props;
  if (state === "none") return null;

  let color: string = text.tertiary;
  if (state === "done" || state === "success") color = stateColor.success;
  else if (state === "error" || state === "danger") color = stateColor.danger;
  else if (state === "warn" || state === "warning") color = stateColor.warning;
  else if (state === "ongoing" || state === "running") color = stateColor.business;

  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface ModalProps {
  open?: boolean;
  onClose?: () => void;
  title?: string;
  headless?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Modal(props: ModalProps) {
  const { open = true, onClose, title, headless, className, style, children } = props;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: mask.backdrop,
        backdropFilter: "blur(2px)",
        boxSizing: "border-box",
      }}
    >
      <div
        className={className}
        style={{
          background: surface.layer1,
          color: text.primary,
          borderRadius: 16,
          border: `1px solid ${surface.border}`,
          boxShadow: shadow.lv3,
          maxWidth: "100%",
          boxSizing: "border-box",
          ...style,
        }}
      >
        {!headless && title && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
              fontSize: 16,
              fontWeight: 600,
              color: text.primary,
            }}
          >
            <span>{title}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  items: MenuItem[];
  onSelect: (id: string) => void;
  anchor: ReactNode;
}

export function Menu(props: MenuProps) {
  const { open, onClose, items, onSelect, anchor } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      {anchor}
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 200,
            minWidth: 180,
            padding: 4,
            borderRadius: 10,
            border: `1px solid ${surface.border}`,
            background: surface.layer1,
            boxShadow: shadow.lv3,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) onSelect(item.id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "7px 10px",
                borderRadius: 7,
                border: "none",
                background: "transparent",
                color: item.danger ? stateColor.danger : text.primary,
                fontFamily: "inherit",
                fontSize: 13,
                textAlign: "left",
                cursor: item.disabled ? "not-allowed" : "pointer",
                opacity: item.disabled ? 0.5 : 1,
              }}
            >
              {item.icon && <span style={{ display: "inline-flex" }}>{item.icon}</span>}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stroke-suffixed Icon Artwork (for compat-icons.ts / icons.ts)
// ---------------------------------------------------------------------------

interface SvgIconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function SvgFrame(props: SvgIconProps & { children: ReactNode }) {
  const s = props.size ?? 16;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      style={{ flexShrink: 0, ...props.style }}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

export function IconChevronDownOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="m6 9 6 6 6-6" />
    </SvgFrame>
  );
}

export function IconChevronRightOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="m9 18 6-6-6-6" />
    </SvgFrame>
  );
}

export function IconGlobeOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </SvgFrame>
  );
}

export function IconCloseOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </SvgFrame>
  );
}

export function IconEditOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </SvgFrame>
  );
}

export function IconPlusOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </SvgFrame>
  );
}

export function IconRefreshOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </SvgFrame>
  );
}

export function IconSearchOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </SvgFrame>
  );
}

export function IconSettingsOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </SvgFrame>
  );
}

export function IconTrashOutlineRegular(props: SvgIconProps) {
  return (
    <SvgFrame {...props}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </SvgFrame>
  );
}
