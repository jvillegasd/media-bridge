from pathlib import Path
from typing import Any, Dict

import yaml

from media_bridge.schemas import Config


def load_config(config_path: Path) -> Dict[Any, Any]:
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, "r") as f:
        raw_config = yaml.safe_load(f)

    # Validate through Pydantic model
    validated_config = Config(**raw_config)
    return validated_config.model_dump()
