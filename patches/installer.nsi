; Ropilot Studio — free build installer.
;
; Installs the patched client (bring-your-own Claude Code / Codex login, no
; Ropilot Credits route, no model gating) as its own product so it can sit
; alongside a paid install without either one clobbering the other. Both share
; %APPDATA%\ropilot, which is where the client keeps projects and settings.
;
; Build:  makensis -V2 installer.nsi
; Needs:  the assembled tree at ./win (resources\app.asar already patched).

Unicode true

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT   "Ropilot Studio Free"
!define PUBLISHER "free build"
!define VERSION   "1.3.2.0"
!define APPEXE    "Ropilot Studio.exe"

Name "${PRODUCT}"
OutFile "Ropilot-Studio-Free-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
InstallDirRegKey HKCU "Software\${PRODUCT}" "InstallDir"
RequestExecutionLevel user

; The payload is 277 MB of Electron. LZMA solid takes the installer down to
; roughly a third of that; the dictionary is large because the binaries repeat.
SetCompressor /SOLID lzma
SetCompressorDictSize 64
SetDatablockOptimize on

VIProductVersion "${VERSION}"
VIAddVersionKey "ProductName"     "${PRODUCT}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "FileDescription" "Ropilot Studio installer (free build)"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "LegalCopyright"  "Electron and Chromium licences ship with the app"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPEXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT}"
!define MUI_FINISHPAGE_LINK "Free build: needs your own Claude Code or Codex login"
!define MUI_FINISHPAGE_LINK_LOCATION "https://github.com/hashYdev"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  ; "/r ...\*" rather than "*.*" — the wildcard form skips extensionless files,
  ; and this tree is full of them.
  File /r "win\*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk" "$INSTDIR\${APPEXE}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT}\Uninstall ${PRODUCT}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${APPEXE}"

  WriteRegStr HKCU "Software\${PRODUCT}" "InstallDir" "$INSTDIR"

  ; Add/Remove Programs entry, so it uninstalls like anything else.
  !define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
  WriteRegStr   HKCU "${UNKEY}" "DisplayName"     "${PRODUCT}"
  WriteRegStr   HKCU "${UNKEY}" "DisplayVersion"  "1.3.2"
  WriteRegStr   HKCU "${UNKEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKCU "${UNKEY}" "DisplayIcon"     "$INSTDIR\${APPEXE}"
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT}"

  ; Remove the program tree itself.
  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
  DeleteRegKey HKCU "Software\${PRODUCT}"

  ; %APPDATA%\ropilot is deliberately left alone: it holds the user's projects,
  ; chats and provider logins, and a paid install shares it.
SectionEnd
