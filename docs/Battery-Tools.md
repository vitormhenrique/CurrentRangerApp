---
layout: default
title: Battery Tools
nav_order: 7
---

# Battery Tools

## Overview

Estimate battery runtime from capacity, or required capacity from desired runtime, using the measured average current.

## Data Source

The average current can come from:
- **Auto mode** (default) — uses the average from the current selection or chart view
  - When a selection is active, shows a `selection` badge and uses selection stats
  - Otherwise uses the chart window average
  - The resolved value is shown as a read-only **"Using: X.XX uA (source)"** line
- **Manual mode** — type a value in the Current (mA) field to override

## Runtime Estimator

Given a battery capacity and average current, estimates how long the battery will last.

**Inputs:**
- **Current (mA)** — auto from chart/selection, or manual
- **Capacity (mAh)** — battery rated capacity

**Outputs:**
- **Runtime** — estimated hours/minutes
- **Effective capacity** — after derating
- **Effective current** — after derating

## Capacity Estimator

Given a desired runtime and average current, estimates the required battery capacity.

**Inputs:**
- **Current (mA)** — auto or manual
- **Runtime (h)** — desired runtime in hours

**Outputs:**
- **Required rated capacity** — including derating overhead
- **Required net capacity** — raw energy needed

## Derating Factors

Expand **Derating factors** to adjust:

| Factor | Default | Description |
|--------|---------|-------------|
| **Efficiency** | 100% | DC-DC converter or regulator efficiency |
| **Depth of Discharge** | 100% | Usable fraction of battery capacity |
| **Aging Margin** | 100% | Capacity loss over battery lifetime |

All factors multiply together: `effective = rated x efficiency x DoD x aging`.
