/**
 * dsh-web-tools — UI primitives icon compatibility (Issue #7).
 *
 * DSH 0.1.7 renamed the 10 product icons this card uses from size-suffixed
 * exports (`IconSearchOutline16`) to stroke-suffixed artwork (`…Regular`).
 *
 * The FIRST attempt at this fix patched the old names onto the primitives
 * namespace. That cannot work, and the tests below pin why: the web shell seeds
 * its module table with the namespace it already froze
 * (`Object.freeze(Object.defineProperty({…}, Symbol.toStringTag, …))`) and the
 * loader stores that reference verbatim
 * (`new Map(Object.entries(options.staticModules))`), so the assignment is a
 * silent no-op in a non-strict bundle — the icons stayed `undefined` and React
 * rejected them (error #130). `resolveIcon` therefore RESOLVES the old names
 * against the live module instead of writing to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { ICON_ALIASES, NULL_ICON, resolveIcon, type IconAliasSpec } from "../src/client/compat-icons.ts";

test("ICON_ALIASES maps all 10 renamed icons to their stroke-suffixed artwork", () => {
  const expectedOldNames = [
    "IconChevronDownOutline14",
    "IconChevronRightOutline14",
    "IconGlobeOutline14",
    "IconCloseOutline16",
    "IconEditOutline16",
    "IconPlusOutline16",
    "IconRefreshOutline16",
    "IconSearchOutline16",
    "IconSettingsOutline16",
    "IconTrashOutline16",
  ];

  assert.equal(ICON_ALIASES.length, 10);
  for (const name of expectedOldNames) {
    const found = ICON_ALIASES.find(([legacy]) => legacy === name);
    assert.ok(found, `must include ${name}`);
    assert.equal(found![1], name.replace(/1[46]$/, "Regular"), `${name} artwork target`);
    assert.equal(found![2], Number(name.slice(-2)), `${name} nominal size`);
  }
});

test("a frozen namespace without legacy names still resolves every icon", () => {
  // Exactly what the shell hands out on 0.1.7+: the namespace is frozen and the
  // size-suffixed names are gone, so nothing may rely on writing to it.
  const artwork: Record<string, unknown> = { Button: () => null };
  for (const [, artworkName] of ICON_ALIASES) {
    artwork[artworkName] = (props: Record<string, unknown>) => React.createElement("svg", props);
  }
  const frozen = Object.freeze(artwork);
  assert.equal(Object.isFrozen(frozen), true, "precondition: the shell namespace is frozen");

  for (const spec of ICON_ALIASES) {
    const [legacyName] = spec;
    assert.equal(frozen[legacyName as keyof typeof frozen], undefined, `${legacyName} is absent on 0.1.7+`);

    const Icon = resolveIcon(frozen as Record<string, unknown>, spec);
    assert.notEqual(Icon, NULL_ICON, `${legacyName} must resolve, not fall back`);
    assert.equal(typeof Icon, "function");

    // The nominal size is applied, and caller props win over it.
    const el = (Icon as any)({}) as React.ReactElement<any>;
    assert.equal(el.props.size, spec[2], `${legacyName} nominal size`);
    const custom = (Icon as any)({ size: 13, className: "x" }) as React.ReactElement<any>;
    assert.equal(custom.props.size, 13);
    assert.equal(custom.props.className, "x");
  }
});

test("resolution prefers a host that still publishes the legacy name", () => {
  const legacy = () => React.createElement("svg", { "data-legacy": "1" });
  const modern = () => React.createElement("svg", { "data-modern": "1" });
  const host = { IconChevronDownOutline14: legacy, IconChevronDownOutlineRegular: modern };
  const spec: IconAliasSpec = ["IconChevronDownOutline14", "IconChevronDownOutlineRegular", 14];

  assert.equal(resolveIcon(host, spec), legacy, "pre-0.1.7 hosts keep their own component (and its size)");
});

test("an unknown future rename degrades to a null renderer, never to undefined", () => {
  // Undefined is what makes React throw #130 and take the whole card down; a
  // null renderer costs one missing glyph instead.
  const spec: IconAliasSpec = ["IconChevronDownOutline14", "IconChevronDownOutlineRegular", 14];
  assert.equal(resolveIcon({}, spec), NULL_ICON, "no artwork at all");
  assert.equal(resolveIcon(undefined, spec), NULL_ICON, "no module at all");
  const el = (NULL_ICON as any)({}) as React.ReactElement<any> | null;
  assert.equal(el, null, "the fallback renders nothing");
});

test("standalone primitives & icons.ts resolve all 10 icons from stroke-suffixed artwork", async () => {
  const primitives = await import("../lib/client/primitives.js");
  const icons = await import("../lib/client/icons.js");

  for (const [legacyName, artworkName, nominalSize] of ICON_ALIASES) {
    assert.equal(
      typeof (primitives as Record<string, unknown>)[artworkName],
      "function",
      `primitives.tsx must export ${artworkName}`,
    );
    const Resolved = (icons as Record<string, unknown>)[legacyName] as React.ComponentType<any>;
    assert.equal(typeof Resolved, "function", `icons.ts must export ${legacyName}`);
    assert.notEqual(Resolved, NULL_ICON, `${legacyName} must not fall back to NULL_ICON`);
    const el = (Resolved as any)({}) as React.ReactElement<any>;
    assert.equal(el.props.size, nominalSize, `${legacyName} must carry nominal size ${nominalSize}`);
  }
});
