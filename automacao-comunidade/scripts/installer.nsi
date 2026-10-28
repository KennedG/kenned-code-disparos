; Instalador por usuário: independente, sem compartilhar sessão ou registro de outros aplicativos.
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
InstallDir "$LOCALAPPDATA\Programs\Automação Comunidade"
InstallDirRegKey HKCU "Software\KennedCode\AutomacaoComunidade" "InstallDir"
ShowInstDetails show
ShowUninstDetails show
SetCompressor lzma
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Automação Comunidade.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Automação Comunidade"
!define MUI_WELCOMEPAGE_TITLE "Bem-vindo à Automação Comunidade"
!define MUI_WELCOMEPAGE_TEXT "Organize convites autorizados para a sua comunidade pelo WhatsApp.$\r$\n$\r$\nEste é um aplicativo independente, com banco de dados e sessão próprios. Feche uma instalação anterior antes de atualizar. Seus dados locais serão preservados.$\r$\n$\r$\nA integração Baileys é não oficial. Envie convites somente para contatos autorizados. O modo de simulação não envia mensagens reais."
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
    MessageBox MB_OK|MB_ICONSTOP "A Automação Comunidade requer Windows 10 ou 11."
    Abort
  ${EndIf}
FunctionEnd
Function ValidateInstallDirectory
  ${GetFileName} "$INSTDIR" $0
  StrCmp $0 "Automação Comunidade" validDirectory
  MessageBox MB_OK|MB_ICONSTOP "Escolha uma pasta dedicada com o nome Automação Comunidade. Isso protege arquivos de outros programas."
  Abort
  validDirectory:
FunctionEnd
Function EnsureAppClosed
  checkRunning:
  FindWindow $0 "Chrome_WidgetWin_1" "Automação Comunidade"
  StrCmp $0 0 appClosed
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "A Automação Comunidade ainda está aberta, inclusive na bandeja. Encerre-a antes de instalar ou atualizar." IDRETRY checkRunning
  Abort
  appClosed:
FunctionEnd
Function un.EnsureAppClosed
  checkRunning:
  FindWindow $0 "Chrome_WidgetWin_1" "Automação Comunidade"
  StrCmp $0 0 appClosed
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "A Automação Comunidade ainda está aberta, inclusive na bandeja. Encerre-a antes de desinstalar." IDRETRY checkRunning
  Abort
  appClosed:
FunctionEnd
Section "Automação Comunidade (obrigatório)" MainSection
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
  IfFileExists "$INSTDIR\Automação Comunidade.exe" 0 failed
  IfFileExists "$INSTDIR\resources\app.asar" 0 failed
  IfFileExists "$INSTDIR\.automacao-comunidade-owned-files.txt" 0 failed
  File /oname=Leia-me.md "${PROJECT_DIR}/README.md"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  CreateDirectory "$SMPROGRAMS\Automação Comunidade"
  CreateShortCut "$SMPROGRAMS\Automação Comunidade\Automação Comunidade.lnk" "$INSTDIR\Automação Comunidade.exe"
  WinShell::SetLnkAUMI "$SMPROGRAMS\Automação Comunidade\Automação Comunidade.lnk" "br.com.kennedcode.automacaocomunidade"
  CreateShortCut "$SMPROGRAMS\Automação Comunidade\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKCU "Software\KennedCode\AutomacaoComunidade" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade" "DisplayName" "Automação Comunidade"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade" "Publisher" "Kenned Code"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade" "UninstallString" '$\"$INSTDIR\Desinstalar.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade" "DisplayIcon" "$INSTDIR\Automação Comunidade.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade" "NoRepair" 1
  Goto done
  failed:
    MessageBox MB_OK|MB_ICONSTOP "Não foi possível instalar todos os arquivos. Feche a Automação Comunidade e tente novamente. Seus dados não foram apagados."
    Abort
  done:
SectionEnd
Section /o "Atalho na área de trabalho" DesktopSection
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Automação Comunidade.lnk" "$INSTDIR\Automação Comunidade.exe"
  WinShell::SetLnkAUMI "$DESKTOP\Automação Comunidade.lnk" "br.com.kennedcode.automacaocomunidade"
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  Call un.EnsureAppClosed
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Os contatos, campanhas, controles de convites, configurações e a sessão protegida em AppData serão preservados." IDOK +2
  Abort
  Delete "$DESKTOP\Automação Comunidade.lnk"
  Delete "$SMPROGRAMS\Automação Comunidade\Automação Comunidade.lnk"
  Delete "$SMPROGRAMS\Automação Comunidade\Desinstalar.lnk"
  RMDir "$SMPROGRAMS\Automação Comunidade"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Automação Comunidade"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutomacaoComunidade"
  DeleteRegKey HKCU "Software\KennedCode\AutomacaoComunidade"
  ; Remove somente arquivos registrados pelo pacote; não usa RMDir /r no destino.
  FileOpen $0 "$INSTDIR\.automacao-comunidade-owned-files.txt" r
  IfErrors preserved
  ownershipLoop:
    ClearErrors
    FileReadUTF16LE $0 $1
    IfErrors ownershipDone
    ${UnStrTrimNewLines} $1 $1
    StrCpy $2 $1 2
    StrCpy $3 $1 "" 2
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
    Delete "$INSTDIR\.automacao-comunidade-owned-files.txt"
  preserved:
  Delete "$INSTDIR\Leia-me.md"
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir "$INSTDIR"
SectionEnd
