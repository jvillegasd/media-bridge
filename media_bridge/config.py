from pathlib import Path
from typing import Any, Dict

import yaml


def load_config(config_path: Path) -> Dict[Any, Any]:
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, "r") as f:
        return yaml.safe_load(f)
