; Included by electron-builder's NSIS installer (electron-builder.yml: nsis.include).
; Registers the watchtogether:// invite-link scheme for the installing user (plan §4.6 Deep links).
; electron-builder's template registers file associations but not URL schemes, hence this include.
; The values match what Electron's app.setAsDefaultProtocolClient writes, which src/main/deep-links.ts also calls on
; every packaged start: that keeps the handler pointing at the current exe and registers it for other Windows users
; of a per-machine install.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\watchtogether" "" "URL:watchtogether"
  WriteRegStr HKCU "Software\Classes\watchtogether" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\watchtogether\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\watchtogether\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first (--updated); keep the key so links work throughout.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\watchtogether"
  ${endIf}
!macroend
