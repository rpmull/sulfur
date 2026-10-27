; Keep the original per-user Sulfur installation location. Older Go releases
; invoke their signed installer with /S /RESTART when applying an update.
!include "FileFunc.nsh"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $0 HKCU "Software\Phosphorus\Sulfur" ""
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Phosphorus\Sulfur" "" "$INSTDIR"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/RESTART" $1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\sulfur.exe"'
  ${EndIf}
!macroend
