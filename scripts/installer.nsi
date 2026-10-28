; Instalador nativo NSIS por usuário. O desinstalador é gerado no Windows,
; sem executar binários Windows no computador de compilação.
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${UnStrStr}
${UnStrTrimNewLines}

Name "${PRODUCT_NAME}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Mega Disparos"
InstallDirRegKey HKCU "Software\Mega Disparos" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
SetCompressor lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mega Disparos.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Mega Disparos"
!define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao Mega Disparos"
!define MUI_WELCOMEPAGE_TEXT "Este assistente instala o Mega Disparos neste computador.$\r$\n$\r$\nFeche uma instalação anterior antes de continuar. Os seus dados locais serão preservados.$\r$\n$\r$\nO aplicativo começa em simulação, com a campanha de exemplo desativada."
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
    MessageBox MB_OK|MB_ICONSTOP "O Mega Disparos requer Windows 10 ou 11."
    Abort
  ${EndIf}
FunctionEnd

Function ValidateInstallDirectory
  ${GetFileName} "$INSTDIR" $0
  StrCmp $0 "Mega Disparos" validDirectory
  MessageBox MB_OK|MB_ICONSTOP "Escolha uma pasta dedicada com o nome Mega Disparos, por exemplo C:\Apps\Mega Disparos. Isso protege arquivos de outros programas."
  Abort
  validDirectory:
FunctionEnd

Function EnsureAppClosed
  checkRunning:
  FindWindow $0 "Chrome_WidgetWin_1" "Mega Disparos"
  StrCmp $0 0 appClosed
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "O Mega Disparos ainda está aberto, inclusive na bandeja. Encerre-o pelo menu da bandeja antes de instalar ou atualizar." IDRETRY checkRunning
  Abort
  appClosed:
FunctionEnd

Function un.EnsureAppClosed
  checkRunning:
  FindWindow $0 "Chrome_WidgetWin_1" "Mega Disparos"
  StrCmp $0 0 appClosed
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "O Mega Disparos ainda está aberto, inclusive na bandeja. Encerre-o pelo menu da bandeja antes de desinstalar." IDRETRY checkRunning
  Abort
  appClosed:
FunctionEnd

Section "Mega Disparos (obrigatório)" MainSection
  SectionIn RO
  Call ValidateInstallDirectory
  Call EnsureAppClosed
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$INSTDIR"
  SetCompress off
  File /oname=$PLUGINSDIR\app.7z "${APP_64}"
  SetCompress auto
  ClearErrors
  Nsis7z::Extract "$PLUGINSDIR\app.7z"
  IfErrors failed
  IfFileExists "$INSTDIR\Mega Disparos.exe" 0 failed
  IfFileExists "$INSTDIR\resources\app.asar" 0 failed
  IfFileExists "$INSTDIR\.mega-owned-files.txt" 0 failed
  File /oname=Leia-me.md "${PROJECT_DIR}/README.md"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  CreateDirectory "$SMPROGRAMS\Mega Disparos"
  CreateShortCut "$SMPROGRAMS\Mega Disparos\Mega Disparos.lnk" "$INSTDIR\Mega Disparos.exe"
  WinShell::SetLnkAUMI "$SMPROGRAMS\Mega Disparos\Mega Disparos.lnk" "br.com.megadisparos.desktop"
  CreateShortCut "$SMPROGRAMS\Mega Disparos\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "Software\Mega Disparos" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "DisplayName" "Mega Disparos"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "Publisher" "Mega Disparos"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "UninstallString" '$\"$INSTDIR\Desinstalar.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "DisplayIcon" "$INSTDIR\Mega Disparos.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MegaDisparos" "NoRepair" 1
  Goto done
  failed:
    MessageBox MB_OK|MB_ICONSTOP "Não foi possível instalar todos os arquivos. Feche o Mega Disparos e tente novamente."
    Abort
  done:
SectionEnd

Section /o "Atalho na área de trabalho" DesktopSection
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Mega Disparos.lnk" "$INSTDIR\Mega Disparos.exe"
  WinShell::SetLnkAUMI "$DESKTOP\Mega Disparos.lnk" "br.com.megadisparos.desktop"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.EnsureAppClosed
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Feche o Mega Disparos antes de continuar.$\r$\nAs campanhas, mídias e configurações em AppData serão preservadas." IDOK +2
  Abort
  Delete "$DESKTOP\Mega Disparos.lnk"
  Delete "$SMPROGRAMS\Mega Disparos\Mega Disparos.lnk"
  Delete "$SMPROGRAMS\Mega Disparos\Desinstalar.lnk"
  RMDir "$SMPROGRAMS\Mega Disparos"
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
