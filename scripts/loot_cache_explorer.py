#!/usr/bin/env python3
"""Streamlit explorer for eggincutils mission loot cache data.

Run with:
  streamlit run scripts/loot_cache_explorer.py
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

try:
    import streamlit as st
except ImportError as exc:  # pragma: no cover - runtime guard for local use
    raise SystemExit(
        "streamlit is not installed. Install it with `pip install streamlit` "
        "and rerun `streamlit run scripts/loot_cache_explorer.py`."
    ) from exc


DEFAULT_CACHE_PATH = "/tmp/eggincutils-loot-cache.json"
RARITY_NAMES = ["common", "rare", "epic", "legendary"]


@dataclass(frozen=True)
class LootDataset:
    metadata: dict[str, Any]
    payload: dict[str, Any]
    combos: pd.DataFrame
    items: pd.DataFrame


def load_loot_cache(path_str: str) -> LootDataset:
    path = Path(path_str).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Cache file not found: {path}")

    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        raise ValueError("Cache file must contain a JSON object.")

    payload = raw.get("payload", raw)
    if not isinstance(payload, dict) or not isinstance(payload.get("missions"), list):
        raise ValueError("Cache file does not contain a valid loot payload.")

    combos: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []

    for mission in payload["missions"]:
        ship = mission.get("afxShip")
        duration_type = mission.get("afxDurationType")
        mission_id = mission.get("missionId")
        for level_entry in mission.get("levels", []):
            level = level_entry.get("level")
            for target in level_entry.get("targets", []):
                target_afx_id = target.get("targetAfxId")
                total_drops = target.get("totalDrops", 0)
                combo_key = f"{mission_id} | ship={ship} | duration={duration_type} | level={level} | target={target_afx_id}"
                combos.append(
                    {
                        "combo_key": combo_key,
                        "mission_id": mission_id,
                        "afx_ship": ship,
                        "afx_duration_type": duration_type,
                        "level": level,
                        "target_afx_id": target_afx_id,
                        "total_drops": total_drops,
                        "item_rows": len(target.get("items", [])),
                    }
                )
                for item in target.get("items", []):
                    counts = list(item.get("counts", [0, 0, 0, 0]))
                    counts += [0] * (4 - len(counts))
                    total_item_count = sum(counts[:4])
                    item_row = {
                        "combo_key": combo_key,
                        "mission_id": mission_id,
                        "afx_ship": ship,
                        "afx_duration_type": duration_type,
                        "level": level,
                        "target_afx_id": target_afx_id,
                        "total_drops": total_drops,
                        "afx_id": item.get("afxId"),
                        "afx_level": item.get("afxLevel"),
                        "item_id": item.get("itemId"),
                        "common": counts[0],
                        "rare": counts[1],
                        "epic": counts[2],
                        "legendary": counts[3],
                        "total_item_count": total_item_count,
                        "drop_share": (total_item_count / total_drops) if total_drops else 0.0,
                    }
                    items.append(item_row)

    combos_df = pd.DataFrame(combos).sort_values(
        ["mission_id", "level", "target_afx_id", "afx_ship", "afx_duration_type"]
    )
    items_df = pd.DataFrame(items).sort_values(
        ["mission_id", "level", "target_afx_id", "item_id", "afx_level"]
    )

    metadata = {
        key: value
        for key, value in raw.items()
        if key in {"fetchedAtMs", "lastRefreshAttemptAtMs", "etag"} and value is not None
    }
    metadata["path"] = str(path)
    metadata["mission_count"] = len(payload["missions"])
    metadata["combo_count"] = len(combos_df)
    metadata["item_row_count"] = len(items_df)

    return LootDataset(metadata=metadata, payload=payload, combos=combos_df, items=items_df)


def format_timestamp_ms(value: Any) -> str:
    if not isinstance(value, (int, float)) or value <= 0:
        return "-"
    return pd.to_datetime(int(value), unit="ms", utc=True).strftime("%Y-%m-%d %H:%M:%S UTC")


def multiselect_with_all(label: str, options: list[Any], key: str) -> list[Any]:
    return st.sidebar.multiselect(label, options, default=options, key=key)


def apply_filters(dataset: LootDataset) -> tuple[pd.DataFrame, pd.DataFrame]:
    combos = dataset.combos
    items = dataset.items

    working = combos
    ship_values = multiselect_with_all(
        "Ship (afxShip)", sorted(working["afx_ship"].dropna().unique().tolist()), "ship_filter"
    )
    if ship_values:
        working = working[working["afx_ship"].isin(ship_values)]

    duration_values = multiselect_with_all(
        "Duration (afxDurationType)",
        sorted(working["afx_duration_type"].dropna().unique().tolist()),
        "duration_filter",
    )
    if duration_values:
        working = working[working["afx_duration_type"].isin(duration_values)]

    mission_values = multiselect_with_all(
        "Mission ID", sorted(working["mission_id"].dropna().unique().tolist()), "mission_filter"
    )
    if mission_values:
        working = working[working["mission_id"].isin(mission_values)]

    level_values = multiselect_with_all(
        "Level", sorted(working["level"].dropna().unique().tolist()), "level_filter"
    )
    if level_values:
        working = working[working["level"].isin(level_values)]

    target_values = multiselect_with_all(
        "Target (targetAfxId)",
        sorted(working["target_afx_id"].dropna().unique().tolist()),
        "target_filter",
    )
    if target_values:
        working = working[working["target_afx_id"].isin(target_values)]

    filtered_items = items[items["combo_key"].isin(working["combo_key"])]

    item_values = multiselect_with_all(
        "Item ID", sorted(filtered_items["item_id"].dropna().unique().tolist()), "item_filter"
    )
    if item_values:
        filtered_items = filtered_items[filtered_items["item_id"].isin(item_values)]
        working = working[working["combo_key"].isin(filtered_items["combo_key"])]

    return working, filtered_items


def render_summary(dataset: LootDataset, filtered_combos: pd.DataFrame, filtered_items: pd.DataFrame) -> None:
    metadata = dataset.metadata
    fetched_at = format_timestamp_ms(metadata.get("fetchedAtMs"))
    refreshed_at = format_timestamp_ms(metadata.get("lastRefreshAttemptAtMs"))

    st.caption(f"Cache file: `{metadata['path']}`")
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("Missions", f"{metadata['mission_count']:,}")
    col2.metric("Combos", f"{len(filtered_combos):,}", delta=f"{metadata['combo_count']:,} total")
    col3.metric("Item rows", f"{len(filtered_items):,}", delta=f"{metadata['item_row_count']:,} total")
    col4.metric("Distinct items", f"{filtered_items['item_id'].nunique():,}")

    meta_col1, meta_col2, meta_col3 = st.columns(3)
    meta_col1.write(f"Fetched: `{fetched_at}`")
    meta_col2.write(f"Refresh attempt: `{refreshed_at}`")
    meta_col3.write(f"ETag: `{metadata.get('etag', '-')}`")


def render_combo_table(filtered_combos: pd.DataFrame) -> None:
    st.subheader("Mission combo totals")
    if filtered_combos.empty:
        st.warning("No mission combos match the current filters.")
        return

    display = filtered_combos.sort_values(
        ["mission_id", "level", "target_afx_id", "afx_ship", "afx_duration_type"]
    )[
        [
            "mission_id",
            "afx_ship",
            "afx_duration_type",
            "level",
            "target_afx_id",
            "total_drops",
            "item_rows",
            "combo_key",
        ]
    ]
    st.dataframe(display, use_container_width=True, hide_index=True)


def render_item_tables(filtered_items: pd.DataFrame) -> None:
    st.subheader("Item totals in current slice")
    if filtered_items.empty:
        st.warning("No item rows match the current filters.")
        return

    aggregated = (
        filtered_items.groupby(["item_id", "afx_id", "afx_level"], dropna=False)[RARITY_NAMES + ["total_item_count"]]
        .sum()
        .reset_index()
        .sort_values(["total_item_count", "item_id", "afx_level"], ascending=[False, True, True])
    )
    st.dataframe(aggregated, use_container_width=True, hide_index=True)

    st.subheader("Detailed rows")
    details = filtered_items.sort_values(
        ["mission_id", "level", "target_afx_id", "item_id", "afx_level"]
    )[
        [
            "mission_id",
            "afx_ship",
            "afx_duration_type",
            "level",
            "target_afx_id",
            "item_id",
            "afx_id",
            "afx_level",
            "common",
            "rare",
            "epic",
            "legendary",
            "total_item_count",
            "total_drops",
            "drop_share",
        ]
    ]
    st.dataframe(
        details.style.format({"drop_share": "{:.4f}"}),
        use_container_width=True,
        hide_index=True,
    )


def render_raw_json(dataset: LootDataset, filtered_combos: pd.DataFrame, filtered_items: pd.DataFrame) -> None:
    st.subheader("Raw JSON slice")
    if filtered_combos.empty:
        st.info("Narrow the filters to inspect raw JSON for matching combos.")
        return

    selected_keys = set(filtered_combos["combo_key"].tolist())
    selected_items = None
    if not filtered_items.empty:
        selected_items = set(
            zip(
                filtered_items["combo_key"],
                filtered_items["item_id"],
                filtered_items["afx_id"],
                filtered_items["afx_level"],
            )
        )

    missions_out: list[dict[str, Any]] = []
    for mission in dataset.payload["missions"]:
        levels_out: list[dict[str, Any]] = []
        for level_entry in mission.get("levels", []):
            targets_out: list[dict[str, Any]] = []
            for target in level_entry.get("targets", []):
                combo_key = (
                    f"{mission.get('missionId')} | ship={mission.get('afxShip')} | "
                    f"duration={mission.get('afxDurationType')} | level={level_entry.get('level')} | "
                    f"target={target.get('targetAfxId')}"
                )
                if combo_key not in selected_keys:
                    continue
                target_copy = dict(target)
                if selected_items is not None:
                    target_copy["items"] = [
                        item
                        for item in target.get("items", [])
                        if (
                            combo_key,
                            item.get("itemId"),
                            item.get("afxId"),
                            item.get("afxLevel"),
                        )
                        in selected_items
                    ]
                targets_out.append(target_copy)
            if targets_out:
                levels_out.append({"level": level_entry.get("level"), "targets": targets_out})
        if levels_out:
            missions_out.append(
                {
                    "afxShip": mission.get("afxShip"),
                    "afxDurationType": mission.get("afxDurationType"),
                    "missionId": mission.get("missionId"),
                    "levels": levels_out,
                }
            )

    st.json({"missions": missions_out}, expanded=False)


@st.cache_data(show_spinner=False)
def cached_load(path_str: str) -> LootDataset:
    return load_loot_cache(path_str)


def main() -> None:
    st.set_page_config(page_title="Loot Cache Explorer", layout="wide")
    st.title("Loot Cache Explorer")
    st.write("Inspect mission loot totals from the local eggincutils loot cache.")

    cache_path = st.sidebar.text_input("Cache file", value=DEFAULT_CACHE_PATH)
    refresh_requested = st.sidebar.button("Reload from disk")
    if refresh_requested:
        cached_load.clear()

    try:
        dataset = cached_load(cache_path)
    except Exception as exc:
        st.error(str(exc))
        st.stop()

    st.sidebar.markdown("### Filters")
    filtered_combos, filtered_items = apply_filters(dataset)

    render_summary(dataset, filtered_combos, filtered_items)
    st.divider()
    render_combo_table(filtered_combos)
    st.divider()
    render_item_tables(filtered_items)

    with st.expander("Raw JSON for current slice"):
        render_raw_json(dataset, filtered_combos, filtered_items)


if __name__ == "__main__":
    main()
