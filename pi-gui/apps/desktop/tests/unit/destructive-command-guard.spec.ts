import { expect, test } from "@playwright/test";
import { findDestructiveCommand } from "../../electron/assistant/coworker-extensions";

test("blocks destructive shell commands", () => {
  const blocked = [
    "rm -rf ~/projects",
    "rm -fr /tmp/x",
    "rm -f -r /",
    "rm -r -f x",
    "rm /home/x -rf",
    "rm --recursive --force /",
    "sudo rm -rf /var",
    "cd /tmp && rm -rf ./out",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "wipefs -a /dev/sda",
    "blkdiscard /dev/sda",
    "sgdisk -o /dev/sda",
    "parted /dev/sda mklabel gpt",
    "format C:",
    "del /f /s /q C:\\Users",
    "del C:\\* /s /q",
    "rmdir /s /q C:\\Users\\me",
    "rd /S /Q C:\\folder",
    "Remove-Item -Path C:\\x -Recurse -Force",
    "Remove-Item -r -fo C:\\x",
    "shutdown /s /t 0",
    "Stop-Computer -Force",
    "systemctl poweroff",
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "reg delete HKLM\\Software\\X /f",
    "cipher /w:C",
    "vssadmin delete shadows /all",
    "bcdedit /delete {current}",
    "fun(){ fun|fun& };fun",
    "bomb() { bomb | bomb & }; bomb",
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
    "git push --force-if-includes origin main",
    "npm test",
    "echo hello",
    "rm file.txt",
    "rm -r build",
    "rm -f notes.txt",
    "echo 'format C: drive'",
    "echo 'reg delete' as text",
    "grep -rn shutdown src",
    "git log --grep=shutdown",
    "diskpart /?",
    "shutdown --help",
  ];
  for (const command of allowed) {
    expect(findDestructiveCommand(command), command).toBeNull();
  }
});
