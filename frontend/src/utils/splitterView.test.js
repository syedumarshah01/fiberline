/**
 * Tests for the splitter/port display helpers.
 *
 * These exist because the panel is where a wrong "free port" count turns into a
 * person driving to a box that cannot take the drop. The helpers phrase what the
 * API counted; nothing here recounts ports, and the tests pin that — feeding in
 * a port_summary of 0 free must never render as capacity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  portIsDamaged,
  splitterRatio,
  splitterHasFreePort,
  splitterCapacityLine,
  splitterLossText,
  portUsageText,
  portStatePill,
  boxCapacityLine,
} from "./splitterView.js";

const splitter = (overrides = {}) => ({
  id: "sp1",
  split_count: 8,
  loss_db: null,
  effective_loss_db: 10.5,
  loss_measured: false,
  ports: [],
  port_summary: {
    total: 8,
    free: 3,
    used: 5,
    cascaded: 0,
    damaged: 0,
    free_port_numbers: [5, 6, 7],
    used_port_numbers: [1, 2, 3, 4, 8],
    cascaded_port_numbers: [],
    damaged_port_numbers: [],
    customer_labels: [],
  },
  ...overrides,
});

test("ratio comes from the API label, falling back to the stored count", () => {
  assert.equal(splitterRatio(splitter()), "1:8");
  assert.equal(splitterRatio({ split_count: 32 }), "1:32");
  assert.equal(splitterRatio({ ratio: "1:16", split_count: 16 }), "1:16");
  assert.equal(splitterRatio({ split_count: null }), null);
  assert.equal(splitterRatio(null), null);
});

test("a splitter is free only when the API says it has free ports", () => {
  assert.equal(splitterHasFreePort(splitter()), true);
  assert.equal(
    splitterHasFreePort(splitter({ port_summary: { ...splitter().port_summary, free: 0 } })),
    false,
  );
  assert.equal(splitterHasFreePort({ id: "x" }), false, "no summary means no claim of capacity");
});

test("capacity line names the free ports a technician has to write down", () => {
  assert.equal(splitterCapacityLine(splitter()), "1:8 splitter · 3 of 8 free (5, 6, 7)");
});

test("a full splitter says 'full', not '0 free'", () => {
  const full = splitter({
    port_summary: { ...splitter().port_summary, free: 0, used: 8, free_port_numbers: [] },
  });
  assert.equal(splitterCapacityLine(full), "1:8 splitter · full — all 8 ports taken");
});

test("cascaded and damaged ports are called out separately", () => {
  const mixed = splitter({
    port_summary: {
      ...splitter().port_summary,
      free: 1,
      used: 4,
      cascaded: 2,
      damaged: 1,
      free_port_numbers: [8],
    },
  });
  const line = splitterCapacityLine(mixed);
  assert.match(line, /1 of 8 free \(8\)/);
  assert.match(line, /2 feeding another splitter/);
  assert.match(line, /1 damaged/);
});

test("a splitter with no port rows says so instead of claiming capacity", () => {
  const bare = splitter({ port_summary: { total: 0, free: 0, used: 0, cascaded: 0, damaged: 0 } });
  assert.equal(splitterCapacityLine(bare), "1:8 splitter · no ports recorded");
});

test("loss text always says whether the dB was measured or planned", () => {
  assert.equal(splitterLossText(splitter()), "10.5 dB planned");
  assert.equal(
    splitterLossText(splitter({ effective_loss_db: 9.12, loss_measured: true })),
    "9.12 dB measured",
  );
  assert.equal(splitterLossText(splitter({ effective_loss_db: null })), null);
  assert.equal(splitterLossText(null), null);
});

test("a used port shows the customer's label, because that is what the tag says", () => {
  assert.equal(
    portUsageText({ port_number: 1, output_core_id: "c1", customer_label: "CUST-10234" }),
    "CUST-10234",
  );
});

test("a port with a core but no customer label falls back to cable + core", () => {
  assert.equal(
    portUsageText({ port_number: 2, output_core_id: "c2", cable_code: "CBL-D7", core_number: 3 }),
    "CBL-D7 #3",
  );
});

test("a cascaded port names the splitter it feeds", () => {
  assert.equal(
    portUsageText({ port_number: 3, output_splitter_id: "child", child_splitter_name: "Splitter 1:4" }),
    "→ Splitter 1:4",
  );
});

test("a free port reads as free", () => {
  assert.equal(portUsageText({ port_number: 4, usage: "free" }), "free");
  assert.equal(portUsageText(null), "—");
});

test("a damaged empty port never reads as free, because the count excludes it", () => {
  // The regression this pins: the capacity line said "3 of 8 free" while the
  // port row said "free" for a port the API had already excluded as damaged.
  assert.equal(portUsageText({ port_number: 4, usage: "free", status: "damaged" }), "damaged — not usable");
  assert.equal(portIsDamaged({ status: "damaged" }), true);
  assert.equal(portIsDamaged({ port_status: "damaged" }), true);
  assert.equal(portIsDamaged({ status: "active" }), false);
});

test("a damaged port carrying a customer still shows the customer", () => {
  const text = portUsageText({
    port_number: 2,
    usage: "core",
    status: "damaged",
    output_core_id: "c2",
    customer_label: "CUST-2",
  });
  assert.equal(text, "CUST-2", "the person on the port is the thing to keep visible");
});

test("port pills distinguish free, in use, cascaded and damaged", () => {
  assert.equal(portStatePill({ usage: "free" }).text, "free");
  assert.equal(portStatePill({ output_core_id: "c1" }).text, "in use");
  assert.equal(portStatePill({ output_splitter_id: "child" }).text, "cascaded");
  assert.equal(
    portStatePill({ status: "damaged", usage: "free" }).text,
    "damaged",
    "a damaged empty port is not free",
  );
});

test("box capacity line summarises the splitters in the box", () => {
  assert.equal(
    boxCapacityLine({ splitters: 2, ports: 12, free_ports: 4 }, 2),
    "4 free ports across 2 splitters",
  );
  assert.equal(
    boxCapacityLine({ splitters: 1, ports: 8, free_ports: 1 }, 1),
    "1 free port across 1 splitter",
  );
  assert.equal(
    boxCapacityLine({ splitters: 1, ports: 8, free_ports: 0 }, 1),
    "All 8 ports across 1 splitter are taken",
  );
  assert.equal(boxCapacityLine({ splitters: 0, ports: 0, free_ports: 0 }, 0), "No splitters documented in this box");
});
