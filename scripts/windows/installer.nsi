Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "${PAYLOAD_MANIFEST}"

!define PRODUCT "Absolute Optimizer"
!define INSTALL_PATH "$LOCALAPPDATA\Programs\${PRODUCT}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AbsoluteOptimizer"

Name "${PRODUCT}"
OutFile "${INSTALLER_PATH}"
InstallDir "${INSTALL_PATH}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1049 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1049 "FileDescription" "Установка Absolute Optimizer"
VIAddVersionKey /LANG=1049 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1049 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1049 "LegalCopyright" "Absolute Optimizer"

!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\AbsoluteOptimizer.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить Absolute Optimizer"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Var SetupLock

!macro AcquireSetupLock
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\AbsoluteOptimizerSetup") p .r0 ?e'
  Pop $1
  StrCpy $SetupLock $0
  ${If} $SetupLock == 0
  ${OrIf} $1 == 183
    MessageBox MB_OK|MB_ICONEXCLAMATION "Завершите установку или удаление в другом окне." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

Function .onInit
  StrCpy $INSTDIR "${INSTALL_PATH}"
  ${IfNot} ${AtLeastWin10}
  ${OrIfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Требуется 64-разрядная Windows 10 или 11." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  !insertmacro AcquireSetupLock
FunctionEnd

Function un.onInit
  StrCpy $INSTDIR "${INSTALL_PATH}"
  !insertmacro AcquireSetupLock
FunctionEnd

Section "Absolute Optimizer"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r "${APP_DIR}/*"
  IfErrors failed
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\AbsoluteOptimizer.exe,0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\AbsoluteOptimizer.exe"
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\AbsoluteOptimizer.exe"
  IfErrors failed done

  failed:
    SetErrorLevel 1
    Abort "Закройте Absolute Optimizer и повторите установку."
  done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetOutPath "$TEMP"
  ClearErrors
  !insertmacro RemovePayloadFiles
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Закройте Absolute Optimizer и повторите удаление." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}

  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  Delete "$INSTDIR\Uninstall.exe"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  !insertmacro RemovePayloadDirectories
  RMDir "$INSTDIR"
SectionEnd
