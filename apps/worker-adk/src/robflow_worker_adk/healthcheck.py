from .main import create_config


def main() -> int:
    create_config()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
