#!/usr/bin/env python3
"""Repackage a Docker image's flattened rootfs into multiple smaller layers.

Cloudflare's container runtime fails to unpack single ~1GB+ gzip layers
"""


from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tarfile
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


def export_rootfs_tar(image: str, dest: Path) -> None:
    """Dumps the image's flattened rootfs to a single tar, headers untouched."""
    container = f"splitsrc-{os.getpid()}"

    run(["docker", "create", "--name", container, image, "/dev/null"],
        stdout=subprocess.DEVNULL)

    try:
        with dest.open("wb") as fh:
            run(["docker", "export", container], stdout=fh)

    finally:
        subprocess.run(["docker", "rm", "-f", container], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def normalize(name: str) -> str:
    return name[2:].lstrip("/") if name.startswith("./") else name.lstrip("/")


def is_junk(name: str) -> bool:
    return normalize(name).split("/", 1)[0] in EXPORT_JUNK


@dataclass
class Scan:
    # every layer carries the full skeleton or Docker invents parents with default modes
    skeleton: list[tarfile.TarInfo] = field(default_factory=list)
    regular: list[tuple[int, tarfile.TarInfo]] = field(default_factory=list)
    hardlinks: list[tarfile.TarInfo] = field(default_factory=list)


def scan_tar(src: tarfile.TarFile) -> Scan:
    scan = Scan()

    for member in src.getmembers():
        if is_junk(member.name):
            continue

        if member.isreg():
            scan.regular.append((member.size, member))
        elif member.islnk():
            scan.hardlinks.append(member)
        else:
            scan.skeleton.append(member)

    return scan


def partition(file_groups: list[tuple[int, tarfile.TarInfo]],
              target_bytes: int) -> list[list[tarfile.TarInfo]]:
    buckets: list[list[tarfile.TarInfo]] = []
    current: list[tarfile.TarInfo] = []
    current_size = 0

    for size, member in sorted(file_groups, key=lambda item: -item[0]):
        if current and current_size + size > target_bytes:
            buckets.append(current)
            current, current_size = [], 0

        current.append(member)
        current_size += size

    if current:
        buckets.append(current)

    return buckets


def place_hardlinks(buckets: list[list[tarfile.TarInfo]], hardlinks: Sequence[tarfile.TarInfo]) -> None:
    """Files a hardlink alongside its target, appended so it's always written after it."""
    index = {normalize(m.name): i for i, bucket in enumerate(buckets) for m in bucket}

    for member in hardlinks:
        bucket = index.get(normalize(member.linkname))

        if bucket is None:
            log(f"  warning: hardlink {member.name} -> {member.linkname} has no target, dropping")
            continue

        buckets[bucket].append(member)


def write_layer_tar(src: tarfile.TarFile, work: Path, index: int,
                    bucket: Sequence[tarfile.TarInfo],
                    skeleton: Sequence[tarfile.TarInfo]) -> Path:
    tar_path = work / f"layer{index}.tar"

    # headers copied as-is: extracting to disk first re-owned everything to the build user
    with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as out:
        for member in skeleton:
            out.addfile(member)

        for member in bucket:
            out.addfile(member, src.extractfile(member) if member.isreg() else None)

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
        rootfs_tar = work / "rootfs.tar"

        log(f"exporting rootfs of {args.src}")
        export_rootfs_tar(args.src, rootfs_tar)

        with tarfile.open(rootfs_tar, "r") as src:
            scan = scan_tar(src)
            buckets = partition(scan.regular, args.target_bytes)
            place_hardlinks(buckets, scan.hardlinks)

            log(f"partitioned {sum(len(b) for b in buckets)} files into "
                f"{len(buckets)} layers (~{args.target_bytes / 1e6:.0f} MB each), "
                f"plus a {len(scan.skeleton)}-entry skeleton in each")

            layer_tars = [
                write_layer_tar(src, work, i, bucket, scan.skeleton)
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
