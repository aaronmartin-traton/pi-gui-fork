import { expect, test } from "@playwright/test";
import { findDestructiveCommand } from "../../electron/assistant/coworker-extensions";

test("blocks destructive shell commands", () => {
  const blocked = [
    "rm -rf ~/projects",
    "rm -fr /tmp/x",
    "sudo rm --recursive --force /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "format C:",
    "del /f /s /q C:\\Users",
    "rmdir /s /q C:\\Users\\me",
    "Remove-Item -Path C:\\x -Recurse -Force",
    "Remove-Item -Force -Recurse C:\\x",
    "shutdown /s /t 0",
    "Stop-Computer -Force",
    "git push --force origin main",
    "git push -f",
    "reg delete HKLM\\Software\\X /f",
    "cipher /w:C",
    "vssadmin delete shadows /all",
  ];
  for (const command of blocked) {
    expect(findDestructiveCommand(command), command).not.toBeNull();
  }
});

test("allows ordinary commands", () => {
  const allowed = [
    "ls -la",
    "Get-ChildItem -Path . -Recurse",
    "Remove-Item ./build/tmp.txt",
    "git push origin main",
    "git push --force-with-lease origin feature",
    "npm test",
    "echo hello",
    "rm file.txt",
  ];
  for (const command of allowed) {
    expect(findDestructiveCommand(command), command).toBeNull();
  }
});
