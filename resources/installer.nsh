!macro customInit
  # electron-builder 的原子复制会把任何锁文件都误报成“应用无法关闭”。
  # 卸载器不存在但 exe 仍存在，说明上次卸载/安装只留下了半安装目录；
  # 不碰可能被安全软件占用的残留文件，改用干净目录并让注册表记住它。
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${AndIfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}-app"
  ${EndIf}
!macroend
