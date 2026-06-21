import base64
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("ghost", Path(__file__).parent / "ghost.py")
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

encode = mod.encode
decode = mod.decode
flatline = mod.flatline
main = mod.main


# ── encode ────────────────────────────────────────────────────────────────────


class TestEncode:
    def test_encodes_md_to_dat(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "ENGRAM.md").write_text("engram content")
        encode()
        dat = tmp_path / "engram.dat"
        assert dat.exists()
        assert base64.b64decode(dat.read_bytes()).decode() == "engram content"

    def test_removes_md_after_encoding(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "ENGRAM.md").write_text("engram content")
        encode()
        assert not (tmp_path / "ENGRAM.md").exists()

    def test_skips_missing_md_files(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        # Only BOOT.md present; others should be silently skipped
        (tmp_path / "BOOT.md").write_text("boot")
        encode()
        assert (tmp_path / "boot.dat").exists()
        assert not (tmp_path / "engram.dat").exists()

    def test_prints_mapping_on_encode(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "FIRMWARE.md").write_text("fw")
        encode()
        out = capsys.readouterr().out
        assert "FIRMWARE.md -> firmware.dat" in out

    def test_encodes_all_mappings(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        for md_name, _ in mod.MAPPINGS:
            (tmp_path / md_name).write_text(f"content of {md_name}")
        encode()
        for _, dat_name in mod.MAPPINGS:
            assert (tmp_path / dat_name).exists()


# ── decode ────────────────────────────────────────────────────────────────────


class TestDecode:
    def test_decodes_dat_to_md(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "engram.dat").write_bytes(base64.b64encode(b"engram data"))
        decode()
        md = tmp_path / "ENGRAM.md"
        assert md.exists()
        assert md.read_text() == "engram data"

    def test_skips_missing_dat_files(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "boot.dat").write_bytes(base64.b64encode(b"boot data"))
        decode()
        assert (tmp_path / "BOOT.md").exists()
        assert not (tmp_path / "ENGRAM.md").exists()

    def test_prints_mapping_on_decode(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "pulse.dat").write_bytes(base64.b64encode(b"pulse"))
        decode()
        out = capsys.readouterr().out
        assert "pulse.dat -> PULSE.md" in out

    def test_decode_does_not_remove_dat(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        (tmp_path / "engram.dat").write_bytes(base64.b64encode(b"data"))
        decode()
        # dat file remains after decode (decode is non-destructive)
        assert (tmp_path / "engram.dat").exists()


# ── flatline ──────────────────────────────────────────────────────────────────


class TestFlatline:
    def _setup(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr(mod, "SENTINEL", tmp_path / ".ghost")
        stock_dir = tmp_path / "stock"
        stock_dir.mkdir()
        for md_name, _ in mod.MAPPINGS:
            (stock_dir / md_name).write_text(f"stock {md_name}")

    def test_restores_stock_md_files(self, tmp_path, monkeypatch, capsys):
        self._setup(tmp_path, monkeypatch)
        flatline()
        # After flatline, encode() runs and removes md files — check dat files exist
        for _, dat_name in mod.MAPPINGS:
            assert (tmp_path / dat_name).exists()

    def test_clears_sentinel(self, tmp_path, monkeypatch, capsys):
        self._setup(tmp_path, monkeypatch)
        sentinel = tmp_path / ".ghost"
        sentinel.touch()
        flatline()
        assert not sentinel.exists()

    def test_prints_persona_wiped(self, tmp_path, monkeypatch, capsys):
        self._setup(tmp_path, monkeypatch)
        flatline()
        out = capsys.readouterr().out
        assert "persona wiped to stock" in out

    def test_flatline_without_sentinel_is_fine(self, tmp_path, monkeypatch, capsys):
        self._setup(tmp_path, monkeypatch)
        # sentinel not created — flatline should not raise
        flatline()
        out = capsys.readouterr().out
        assert "persona wiped to stock" in out

    def test_skips_stock_md_not_present(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr(mod, "SENTINEL", tmp_path / ".ghost")
        (tmp_path / "stock").mkdir()
        # Only BOOT.md in stock
        (tmp_path / "stock" / "BOOT.md").write_text("stock boot")
        flatline()
        assert (tmp_path / "boot.dat").exists()
        assert not (tmp_path / "engram.dat").exists()


# ── main ──────────────────────────────────────────────────────────────────────


class TestMain:
    def test_encode_command(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr(sys, "argv", ["ghost.py", "encode"])
        (tmp_path / "BOOT.md").write_text("boot")
        ret = main()
        assert ret == 0
        assert (tmp_path / "boot.dat").exists()

    def test_decode_command(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr(sys, "argv", ["ghost.py", "decode"])
        (tmp_path / "boot.dat").write_bytes(base64.b64encode(b"boot data"))
        ret = main()
        assert ret == 0
        assert (tmp_path / "BOOT.md").exists()

    def test_unknown_command_returns_one(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["ghost.py", "bogus"])
        ret = main()
        assert ret == 1

    def test_unknown_command_prints_usage(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["ghost.py", "bogus"])
        main()
        err = capsys.readouterr().err
        assert "Usage" in err

    def test_no_command_returns_one(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["ghost.py"])
        ret = main()
        assert ret == 1

    def test_flatline_command(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(mod, "PLUGIN_ROOT", tmp_path)
        monkeypatch.setattr(mod, "SENTINEL", tmp_path / ".ghost")
        (tmp_path / "stock").mkdir()
        monkeypatch.setattr(sys, "argv", ["ghost.py", "flatline"])
        ret = main()
        assert ret == 0
        out = capsys.readouterr().out
        assert "persona wiped to stock" in out
