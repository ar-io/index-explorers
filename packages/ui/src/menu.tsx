/**
 * Menus as the ArDrive design system draws them (section 5, Menus): one
 * card, opened beside the control that opened it and flipped to stay on the
 * screen. A select picks a value from choice rows (a tick slot before each
 * label, so labels line up); an action menu runs one of its items. Up and
 * Down move, Home and End jump, Enter or Space picks, Escape closes, and focus
 * returns to the control. A click outside closes the menu and still reaches
 * what it lands on.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { Icon, type IconName } from './icons.js';

export interface Choice {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface Action {
  label: string;
  icon?: IconName;
  run: () => void;
  /** Starts a new group: a divider goes above it. */
  group?: boolean;
}

type Item = { key: string; label: string; disabled: boolean; icon?: IconName; group?: boolean };

/** Where the open menu goes: under the control, or above it when there is no room below. */
function usePlacement(open: boolean, anchor: { current: HTMLElement | null }) {
  const menu = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState({ up: false, right: false });
  useLayoutEffect(() => {
    if (!open || !anchor.current || !menu.current) return;
    const a = anchor.current.getBoundingClientRect();
    const m = menu.current.getBoundingClientRect();
    setPlace({
      up: a.bottom + m.height + 8 > window.innerHeight && a.top - m.height - 8 > 0,
      right: a.left + m.width > window.innerWidth - 8,
    });
  }, [open]);
  return { menu, place };
}

/** The list both kinds share: the keyboard, the active row, closing on a click outside. */
function MenuList({
  id,
  role,
  items,
  current,
  place,
  menuRef,
  label,
  onPick,
  onClose,
  style,
}: {
  id: string;
  role: 'listbox' | 'menu';
  items: Item[];
  current: string | null;
  place: { up: boolean; right: boolean };
  menuRef: { current: HTMLUListElement | null };
  label: string;
  onPick: (key: string) => void;
  onClose: (refocus: boolean) => void;
  /** Where a menu shared by many controls goes (fixed, beside the one that opened it). */
  style?: Record<string, string>;
}) {
  const enabled = items.filter((it) => !it.disabled);
  const [active, setActive] = useState(
    () => enabled.find((it) => it.key === current)?.key ?? enabled[0]?.key ?? null,
  );
  useEffect(() => {
    menuRef.current?.focus();
    const outside = (e: PointerEvent) => {
      const el = menuRef.current;
      const opener = document.querySelector(`[aria-controls="${id}"][aria-expanded="true"]`);
      if (el && !el.contains(e.target as Node) && !opener?.contains(e.target as Node))
        onClose(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, []);
  const domId = (key: string | null) =>
    key === null ? undefined : `${id}-${items.findIndex((it) => it.key === key)}`;
  useEffect(() => {
    const el = domId(active);
    if (el) document.getElementById(el)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const move = (by: number) => {
    if (!enabled.length) return;
    const i = enabled.findIndex((it) => it.key === active);
    setActive(enabled[(i + by + enabled.length) % enabled.length]!.key);
  };
  const optRole = role === 'listbox' ? 'option' : 'menuitem';
  return (
    <ul
      ref={menuRef}
      id={id}
      role={role}
      aria-label={label}
      class={`menu${place.up ? ' up' : ''}${place.right ? ' right' : ''}${style ? ' fixed' : ''}`}
      style={style}
      tabIndex={-1}
      aria-activedescendant={domId(active)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowUp') move(-1);
        else if (e.key === 'Home') setActive(enabled[0]?.key ?? null);
        else if (e.key === 'End') setActive(enabled.at(-1)?.key ?? null);
        else if ((e.key === 'Enter' || e.key === ' ') && active) onPick(active);
        else if (e.key === 'Escape') onClose(true);
        else if (e.key === 'Tab') onClose(false);
        else return;
        if (e.key !== 'Tab') e.preventDefault();
      }}
    >
      {items.map((it) => (
        <li
          key={it.key}
          id={domId(it.key)}
          role={optRole}
          data-value={it.key}
          class={`choice${it.key === active ? ' active' : ''}${it.group ? ' group' : ''}`}
          aria-selected={role === 'listbox' ? (it.key === current ? 'true' : 'false') : undefined}
          aria-disabled={it.disabled ? 'true' : undefined}
          onPointerMove={() => !it.disabled && setActive(it.key)}
          onClick={() => !it.disabled && onPick(it.key)}
        >
          {role === 'listbox' ? (
            <span class="tick">{it.key === current ? <Icon name="check" /> : null}</span>
          ) : it.icon ? (
            <Icon name={it.icon} />
          ) : null}
          <span class="choice-label">{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Picks one value. `field` draws it as a text field is drawn, for a form;
 * `button` as a secondary button, for a value that is not in a form (a filter).
 */
export function Select({
  id,
  value,
  choices,
  onChange,
  label,
  variant = 'field',
  disabled = false,
  shown,
}: {
  id: string;
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
  /** Names the control for a screen reader when no visible label points at it. */
  label: string;
  variant?: 'field' | 'button';
  disabled?: boolean;
  /** What the control shows, when not the chosen choice's label. */
  shown?: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { menu, place } = usePlacement(open, button);
  const chosen = choices.find((c) => c.value === value);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  return (
    <div class={`select select-${variant}`}>
      <button
        ref={button}
        id={id}
        type="button"
        class="select-control"
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={`${id}-menu`}
        aria-label={label}
        data-value={value}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span class="select-value">{shown ?? chosen?.label ?? ''}</span>
        <Icon name="chevron" />
      </button>
      {open ? (
        <MenuList
          id={`${id}-menu`}
          role="listbox"
          label={label}
          items={choices.map((c) => ({ key: c.value, label: c.label, disabled: !!c.disabled }))}
          current={value}
          place={place}
          menuRef={menu}
          onPick={(v) => {
            close(true);
            if (v !== value) onChange(v);
          }}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

/** A row's or a panel's actions behind one button (the design system's "more" menu). */
export function ActionMenu({
  id,
  label,
  actions,
}: {
  id: string;
  /** "Actions for 7.jpg": names the button and the menu. */
  label: string;
  actions: Action[];
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { menu, place } = usePlacement(open, button);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  return (
    // Inside a row: its clicks and keys are the menu's, not the row's.
    <div
      class="select select-icon"
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        ref={button}
        id={id}
        type="button"
        class="iconbtn"
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={`${id}-menu`}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <MenuList
          id={`${id}-menu`}
          role="menu"
          label={label}
          items={actions.map((a, i) => ({
            key: String(i),
            label: a.label,
            disabled: false,
            ...(a.icon ? { icon: a.icon } : {}),
            ...(a.group ? { group: true } : {}),
          }))}
          current={null}
          place={place}
          menuRef={menu}
          onPick={(k) => {
            close(true);
            actions[Number(k)]?.run();
          }}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

/**
 * One action menu for many rows: each row draws only a plain button (so a
 * long list stays cheap), and this menu opens beside whichever was pressed.
 * The button carries aria-controls={id} and aria-expanded; `anchor` is it.
 */
export function AnchoredMenu({
  id,
  label,
  anchor,
  actions,
  onClose,
}: {
  id: string;
  label: string;
  anchor: HTMLElement;
  actions: Action[];
  onClose: () => void;
}) {
  const menu = useRef<HTMLUListElement>(null);
  const [style, setStyle] = useState<Record<string, string>>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const m = menu.current!.getBoundingClientRect();
    const up = a.bottom + m.height + 8 > window.innerHeight && a.top - m.height - 8 > 0;
    setStyle({
      top: `${Math.round(up ? a.top - m.height - 4 : a.bottom + 4)}px`,
      left: `${Math.round(Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8)))}px`,
    });
  }, [anchor]);
  // A scroll or a resize moves the button out from under the menu: close it.
  useEffect(() => {
    const away = () => onClose();
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, []);
  const close = (refocus: boolean) => {
    onClose();
    if (refocus) anchor.focus();
  };
  return (
    <MenuList
      id={id}
      role="menu"
      label={label}
      items={actions.map((a, i) => ({
        key: String(i),
        label: a.label,
        disabled: false,
        ...(a.icon ? { icon: a.icon } : {}),
        ...(a.group ? { group: true } : {}),
      }))}
      current={null}
      place={{ up: false, right: false }}
      menuRef={menu}
      style={style}
      onPick={(k) => {
        close(true);
        actions[Number(k)]?.run();
      }}
      onClose={close}
    />
  );
}
