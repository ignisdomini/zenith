; ZENIT — NSIS installer additions (electron-builder)

!macro customInstall
  ; remember the installer language (LCID: 1033 English, 1049 Russian) — the program applies it on the next start
  FileOpen $0 "$INSTDIR\resources\install-lang.txt" w
  FileWrite $0 "$LANGUAGE"
  FileClose $0
!macroend

!macro customUnInstall
  ; on update — silent; on removal — offer to delete settings and cached map tiles
  ${ifNot} ${isUpdated}
    IfSilent zenit_keep_data
    ${if} $LANGUAGE == 1049
      MessageBox MB_YESNO|MB_ICONQUESTION "Удалить также настройки и сохранённые тайлы карт?$\r$\n$\r$\n$APPDATA\ZENIT" /SD IDNO IDNO zenit_keep_data
    ${else}
      MessageBox MB_YESNO|MB_ICONQUESTION "Also delete settings and cached map tiles?$\r$\n$\r$\n$APPDATA\ZENIT" /SD IDNO IDNO zenit_keep_data
    ${endif}
    RMDir /r "$APPDATA\ZENIT"
    zenit_keep_data:
  ${endIf}
!macroend
