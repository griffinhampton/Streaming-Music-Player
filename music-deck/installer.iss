; Inno Setup script for Awesome Music Streaming Deck.
;
; Build it with:  winget install JRSoftware.InnoSetup
; then run build.bat, which calls this automatically when ISCC is on the box.
;
; Installs per-user under %LOCALAPPDATA%, which needs no administrator prompt -
; one less scary dialog, and it keeps settings with the person rather than the
; machine.

#define AppName    "Awesome Music Streaming Deck"
#define AppVersion "1.0.0"
#define AppExe     "Awesome Music Streaming Deck.exe"
#define AppUrl     "https://github.com/griffinhampton/Streaming-Music-Player"

[Setup]
AppId={{7C4B2E15-9A3D-4F62-B8E1-2D6A5C0F19B4}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Griffin Hampton
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases

; Per-user: no UAC prompt, and the app keeps its settings next to itself.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto

OutputDir=..\dist
OutputBaseFilename=Awesome-Music-Streaming-Deck-Setup
SetupIconFile=music-deck.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible

; Shown before anyone clicks Install, because being told what a thing does to
; your machine beforehand is the least a download can do.
InfoBeforeFile=INSTALL-NOTES.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
; The whole PyInstaller --onedir output.
Source: "..\dist\{#AppName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Settings and cached artwork live beside the app; clear them out on uninstall
; so nothing is left behind.
Type: filesandordirs; Name: "{app}\cache"
Type: files; Name: "{app}\config.json"
