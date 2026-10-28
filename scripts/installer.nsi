; Instalador nativo NSIS por usuário. O desinstalador é gerado no Windows,
; sem executar binários Windows no computador de compilação.
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${StrTrimNewLines}
${UnStrStr}
${UnStrTrimNewLines}

Name "${PRODUCT_NAME}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Kenned Code Disparos"
; Keep the stable registration key so previous installations update in place.
InstallDirRegKey HKCU "Software\Mega Disparos" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
SetCompressor lzma
Var LegacyExecutableOwned

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Kenned Code Disparos.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Kenned Code Disparos"
!define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao Kenned Code Disparos"
!define MUI_WELCOMEPAGE_TEXT "Este assistente instala o Kenned Code Disparos neste computador.$\r$\n$\r$\nFeche uma instalação anterior antes de continuar. Os seus dados locais serão preservados.$\r$\n$\r$\nO teste gratuito de 72 horas começa no primeiro acesso conectado à internet. Após o teste, ative uma licença mensal ou anual. Os dados serão preservados ao vencer.$\r$\n$\r$\nO modo de simulação não envia mensagens reais."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PROJECT_DIR}/LICENSE"
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateInstallDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Esta versão requer Windows de 64 bits."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "O Kenned Code Disparos requer Windows 10 ou 11."
    Abort
  ${EndIf}
FunctionEnd

Function ValidateInstallDirectory
  ${GetFileName} "$INSTDIR" $0
  StrCmp $0 "Kenned Code Disparos" validDirectory
  ; The previous dedicated install folder is accepted for safe in-place upgrades.
  StrCmp $0 "Mega Disparos" validDirectory
  MessageBox MB_OK|MB_ICONSTOP "Escolha uma pasta dedicada com o nome Kenned Code Disparos, por exemplo C:\Apps\Kenned Code Disparos. Isso protege arquivos de outros programas."
  Abort
  validDirectory:
FunctionEnd

Function EnsureAppClosed
  checkRunning:
  FindWindow $0 "Chrome_WidgetWin_1" "Kenned Code Disparos"
  StrCmp $0 0 checkLegacy runningPrompt
  checkLegacy:
  FindWindow $0 "Chrome_WidgetWin_1" "Mega Disparos"
  StrCmp $0 0 appClosed
  runningPrompt:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "O Kenned Code Disparos ainda está aberto, inclusive na bandeja. Encerre-o pelo menu da bandeja antes de instalar ou atualizar." IDRETRY checkRunning
  Abort
  appClosed:
FunctionEnd

Function un.EnsureAppClosed
  checkRunning:
  FindWindow $0 "Chrome_WidgetWin_1" "Kenned Code Disparos"
  StrCmp $0 0 checkLegacy runningPrompt
  checkLegacy:
  FindWindow $0 "Chrome_WidgetWin_1" "Mega Disparos"
  StrCmp $0 0 appClosed
  runningPrompt:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "O Kenned Code Disparos ainda está aberto, inclusive na bandeja. Encerre-o pelo menu da bandeja antes de desinstalar." IDRETRY checkRunning
  Abort
  appClosed:
FunctionEnd

Function CheckOwnedLegacyExecutable
  ; Remember ownership before the new package replaces its manifest.
  StrCpy $LegacyExecutableOwned 0
  ; Preserve all unknown files and the complete AppData profile.
  FileOpen $0 "$INSTDIR\.mega-owned-files.txt" r
  IfErrors legacyOwnedDone
  legacyOwnedLoop:
    ClearErrors
    FileReadUTF16LE $0 $1
    IfErrors legacyOwnedClose
    ${StrTrimNewLines} $1 $1
    StrCmp $1 "F|Mega Disparos.exe" 0 legacyOwnedLoop
    StrCpy $LegacyExecutableOwned 1
  legacyOwnedClose:
    FileClose $0
  legacyOwnedDone:
FunctionEnd

Function MigrateLegacyStartup
  ; Migrate only the exact commands created by previous versions of this app.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mega Disparos"
  StrCmp $0 '$\"$INSTDIR\Mega Disparos.exe$\" --autostart' migrateLegacyRun
  StrCmp $0 '$INSTDIR\Mega Disparos.exe --autostart' migrateLegacyRun
  StrCmp $0 '$\"$INSTDIR\Mega Disparos.exe$\"' migrateLegacyRun
  StrCmp $0 '$INSTDIR\Mega Disparos.exe' migrateLegacyRun legacyRunDone
  migrateLegacyRun:
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Kenned Code Disparos"
    StrCmp $1 "" 0 clearLegacyRun
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Kenned Code Disparos" '$\"$INSTDIR\Kenned Code Disparos.exe$\" --autostart'
  clearLegacyRun:
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mega Disparos"
  legacyRunDone:
FunctionEnd

Section "Kenned Code Disparos (obrigatório)" MainSection
  SectionIn RO
  Call ValidateInstallDirectory
  Call EnsureAppClosed
  Call CheckOwnedLegacyExecutable
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$INSTDIR"
  SetCompress off
  File /oname=$PLUGINSDIR\app.7z "${APP_64}"
  SetCompress auto
  ClearErrors
  Nsis7z::Extract "$PLUGINSDIR\app.7z"
  IfErrors failed
  IfFileExists "$INSTDIR\Kenned Code Disparos.exe" 0 failed
  IfFileExists "$INSTDIR\resources\app.asar" 0 failed
  IfFileExists "$INSTDIR\.mega-owned-files.txt" 0 failed
  ; Do not remove the previous executable until the replacement is present.
  StrCmp $LegacyExecutableOwned 1 0 +2
  Delete "$INSTDIR\Mega Disparos.exe"
  File /oname=Leia-me.md "${PROJECT_DIR}/README.md"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  ; Replace only the known shortcuts created by the previous installer.
  Delete "$DESKTOP\Mega Disparos.lnk"
  Delete "$SMPROGRAMS\Mega Disparos\Mega Disparos.lnk"
  Delete "$SMPROGRAMS\Mega Disparos\Desinstalar.lnk"
  RMDir "$SMPROGRAMS\Mega Disparos"
  Call MigrateLegacyStartup
  CreateDirectory "$SMPROGRAMS\Kenned Code Disparos"
  CreateShortCut "$SMPROGRAMS\Kenned Code Disparos\Kenned Code Disparos.lnk" "$INSTDIR\Kenned Code Disparos.exe"
  WinShell::SetLnkAUMI "$SMPROGRAMS\Kenned Code Disparos\Kenned Code Disparos.lnk" "br.com.megadisparos.desktop"
  CreateShortCut "$SMPROGRAMS\Kenned Code Disparos\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "Software\Mega Disparos" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "DisplayName" "Kenned Code Disparos"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "Publisher" "Kenned Code Disparos"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "UninstallString" '$\"$INSTDIR\Desinstalar.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "DisplayIcon" "$INSTDIR\Kenned Code Disparos.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "NoRepair" 1
  Goto done
  failed:
    MessageBox MB_OK|MB_ICONSTOP "Não foi possível instalar todos os arquivos. Feche o Kenned Code Disparos e tente novamente."
    Abort
  done:
SectionEnd

Section /o "Atalho na área de trabalho" DesktopSection
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Kenned Code Disparos.lnk" "$INSTDIR\Kenned Code Disparos.exe"
  WinShell::SetLnkAUMI "$DESKTOP\Kenned Code Disparos.lnk" "br.com.megadisparos.desktop"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.EnsureAppClosed
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Feche o Kenned Code Disparos antes de continuar.$\r$\nAs campanhas, mídias e configurações em AppData serão preservadas." IDOK +2
  Abort
  Delete "$DESKTOP\Kenned Code Disparos.lnk"
  Delete "$SMPROGRAMS\Kenned Code Disparos\Kenned Code Disparos.lnk"
  Delete "$SMPROGRAMS\Kenned Code Disparos\Desinstalar.lnk"
  RMDir "$SMPROGRAMS\Kenned Code Disparos"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Kenned Code Disparos"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mega Disparos"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos"
  DeleteRegKey HKCU "Software\Mega Disparos"
  ; Only the package ownership list is deleted. Unknown files keep their folders.
  FileOpen $0 "$INSTDIR\.mega-owned-files.txt" r
  IfErrors preserved
  ownershipLoop:
    ClearErrors
    FileReadUTF16LE $0 $1
    IfErrors ownershipDone
    ${UnStrTrimNewLines} $1 $1
    StrCpy $2 $1 2
    StrCpy $3 $1 "" 2
    ; Ignore malformed or externally edited manifest entries.
    StrCmp $3 "" ownershipLoop
    StrCpy $4 $3 1
    StrCmp $4 "\" ownershipLoop
    ${UnStrStr} $4 $3 ":"
    StrCmp $4 "" +2
    Goto ownershipLoop
    ${UnStrStr} $4 $3 ".."
    StrCmp $4 "" +2
    Goto ownershipLoop
    StrCmp $2 "F|" 0 directoryRecord
    Delete "$INSTDIR\$3"
    Goto ownershipLoop
    directoryRecord:
    StrCmp $2 "D|" 0 ownershipLoop
    RMDir "$INSTDIR\$3"
    Goto ownershipLoop
  ownershipDone:
    FileClose $0
    Delete "$INSTDIR\.mega-owned-files.txt"
  preserved:
  Delete "$INSTDIR\Leia-me.md"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir "$INSTDIR"
SectionEnd
