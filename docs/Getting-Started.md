---
layout: default
title: Getting Started
nav_order: 2
---

# Getting Started

## Requirements

- **CurrentRanger R3** connected via USB
- macOS, Windows, or Linux

## Installation

Download the latest release from the [Releases page](https://github.com/vitormhenrique/CurrentRangerApp/releases).

### macOS

The app is not yet signed with an Apple Developer certificate. After copying to Applications, remove the quarantine flag:
```bash
xattr -cr /Applications/CurrentRanger.app
```
If macOS still shows a warning, right-click the app and select **Open**, then click **Open** in the dialog.

## First Launch

1. Connect your CurrentRanger R3 via USB
2. Launch the application
3. The app will automatically detect and select the CurrentRanger serial port
4. Click **Connect** in the left panel
5. The device will automatically enable USB logging and begin streaming data

## Interface Overview

![CurrentRanger App — Main interface](img/main_page.png)

| Area | Description |
|------|-------------|
| **Top bar** | Navigation (Monitor / Device Config / Console), connection status, workspace actions |
| **Left sidebar** | Connection panel, Charge/Energy integration, Battery tools |
| **Center** | Live chart with toolbar (Y-axis, time window, pause/resume) |
| **Bottom center** | Window stats and Selection stats |
| **Minimap** | Overview of all data below the chart, click to navigate |
| **Right sidebar** | Markers panel |
| **Status bar** | Connection state, sample count, last message, docs and donate links |
