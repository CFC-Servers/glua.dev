#!/usr/bin/env python3
"""Repackage a Docker image's flattened rootfs into multiple smaller layers.

Cloudflare's container runtime fails to unpack single ~1GB+ gzip layers
"""


from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_TARGET_BYTES = 450_000_000
EXPORT_JUNK = (".dockerenv", "dev", "proc", "sys")


def log(message: str) -> None:
    print(f"[split] {message}", flush=True)


def run(cmd: Sequence[str], **kwargs: object) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(list(cmd), check=True, **kwargs)  # type: ignore[arg-type]

    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"command failed ({exc.returncode}): {' '.join(cmd)}") from exc


@dataclass
class ImageConfig:
    env: list[str] = field(default_factory=list)
    exposed_ports: list[str] = field(default_factory=list)
    working_dir: str = ""
    user: str = ""
    entrypoint: list[str] | None = None
    cmd: list[str] | None = None
    stop_signal: str = ""

    @classmethod
    def from_image(cls, image: str) -> ImageConfig:
        out = subprocess.check_output(
            ["docker", "image", "inspect", image, "--format", "{{json .Config}}"]
        )

        raw = json.loads(out)

        return cls(
            env=raw.get("Env") or [],
            exposed_ports=sorted(raw.get("ExposedPorts") or {}),
            working_dir=raw.get("WorkingDir") or "",
            user=raw.get("User") or "",
            entrypoint=raw.get("Entrypoint"),
            cmd=raw.get("Cmd"),
            stop_signal=raw.get("StopSignal") or "",
        )

    def to_dockerfile_lines(self) -> Iterator[str]:
        for entry in self.env:
            key, _, value = entry.partition("=")
            yield f"ENV {key}={json.dumps(value)}"

        for port in self.exposed_ports:
            yield f"EXPOSE {port}"

        if self.working_dir:
            yield f"WORKDIR {self.working_dir}"

        if self.user:
            yield f"USER {self.user}"

        if self.stop_signal:
            yield f"STOPSIGNAL {self.stop_signal}"

        if self.entrypoint is not None:
            yield f"ENTRYPOINT {json.dumps(self.entrypoint)}"

        if self.cmd is not None:
            yield f"CMD {json.dumps(self.cmd)}"


def export_rootfs(image: str, dest: Path) -> None:
    container = f"splitsrc-{os.getpid()}"
    dest.mkdir(parents=True, exist_ok=True)

    run(["docker", "create", "--name", container, image, "/dev/null"],
        stdout=subprocess.DEVNULL)

    try:
        exporter = subprocess.Popen(["docker", "export", container], stdout=subprocess.PIPE)
        run(["tar", "-C", str(dest), "-xpf", "-", "--numeric-owner"], stdin=exporter.stdout)

        if exporter.wait() != 0:
            raise SystemExit("docker export failed")

    finally:
        subprocess.run(["docker", "rm", "-f", container], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for junk in EXPORT_JUNK:
        path = dest / junk

        if path.is_dir() and not path.is_symlink():
            run(["rm", "-rf", str(path)])
        elif path.exists() or path.is_symlink():
            path.unlink()


def scan_rootfs(root: Path) -> tuple[list[tuple[int, list[str]]], list[str]]:
    """Returns (hardlink-grouped regular files with sizes, dir/symlink skeleton)."""
    groups: dict[tuple[int, int], list[str]] = {}
    sizes: dict[tuple[int, int], int] = {}
    skeleton: list[str] = []

    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)

        if rel_dir != ".":
            skeleton.append(rel_dir)

        # symlinks to directories appear in dirnames, not filenames; dropping
        # them breaks merged-usr layouts (/bin -> usr/bin, /lib64 -> usr/lib64)
        for name in dirnames:
            full = os.path.join(dirpath, name)

            if os.path.islink(full):
                skeleton.append(os.path.relpath(full, root))

        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)

            try:
                st = os.lstat(full)
            except OSError:
                continue

            if stat.S_ISLNK(st.st_mode):
                skeleton.append(rel)
                continue

            if not stat.S_ISREG(st.st_mode):
                continue

            key = (st.st_dev, st.st_ino)
            groups.setdefault(key, []).append(rel)
            sizes[key] = st.st_size

    file_groups = [(sizes[key], paths) for key, paths in groups.items()]

    return file_groups, sorted(skeleton)


def partition(file_groups: list[tuple[int, list[str]]], target_bytes: int) -> list[list[str]]:
    buckets: list[list[str]] = []
    current: list[str] = []
    current_size = 0

    for size, paths in sorted(file_groups, key=lambda item: -item[0]):
        if current and current_size + size > target_bytes:
            buckets.append(current)
            current, current_size = [], 0

        current.extend(paths)
        current_size += size

    if current:
        buckets.append(current)

    return buckets


def write_layer_tar(root: Path, work: Path, index: int,
                    bucket: Sequence[str], skeleton: Sequence[str]) -> Path:
    listing = work / f"layer{index}.list"
    listing.write_text("\n".join(sorted(set(bucket) | set(skeleton))) + "\n")

    tar_path = work / f"layer{index}.tar"

    run([
        "tar", "-C", str(root), "--numeric-owner", "--xattrs", "--no-recursion",
        "-cf", str(tar_path), "-T", str(listing),
    ])

    log(f"  layer{index}: {tar_path.stat().st_size / 1e6:.0f} MB "
        f"({len(bucket)} files)")

    return tar_path


def build_split_image(out_tag: str, work: Path, layer_tars: Sequence[Path],
                      config: ImageConfig, platform: str) -> None:
    dockerfile = ["FROM scratch"]
    dockerfile += [f"ADD {tar.name} /" for tar in layer_tars]
    dockerfile += list(config.to_dockerfile_lines())

    (work / "Dockerfile").write_text("\n".join(dockerfile) + "\n")

    run([
        "docker", "build", "--platform", platform,
        "--provenance=false", "--sbom=false", "-t", out_tag, str(work),
    ])


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Split an image's flattened rootfs into multiple smaller layers.")

    parser.add_argument("src", help="source image reference")
    parser.add_argument("out", help="output tag (may equal src)")
    parser.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES,
                        help=f"approximate uncompressed bytes per layer (default {DEFAULT_TARGET_BYTES})")
    parser.add_argument("--platform", default="linux/amd64")
    parser.add_argument("--workdir", type=Path, default=None,
                        help="scratch directory (default: system temp)")

    args = parser.parse_args(argv)

    config = ImageConfig.from_image(args.src)

    with tempfile.TemporaryDirectory(dir=args.workdir) as tmp:
        work = Path(tmp)
        rootfs = work / "rootfs"

        log(f"exporting rootfs of {args.src}")
        export_rootfs(args.src, rootfs)

        file_groups, skeleton = scan_rootfs(rootfs)
        buckets = partition(file_groups, args.target_bytes)

        log(f"partitioned {sum(len(b) for b in buckets)} files into "
            f"{len(buckets)} layers (~{args.target_bytes / 1e6:.0f} MB each)")

        layer_tars = [
            write_layer_tar(rootfs, work, i, bucket, skeleton)
            for i, bucket in enumerate(buckets)
        ]

        log(f"building {args.out}")
        build_split_image(args.out, work, layer_tars, config, args.platform)

    summary = subprocess.check_output([
        "docker", "image", "inspect", args.out,
        "--format", "built {{.Id}} size={{.Size}} layers={{len .RootFS.Layers}}",
    ]).decode().strip()

    log(summary)

    return 0


if __name__ == "__main__":
    sys.exit(main())
