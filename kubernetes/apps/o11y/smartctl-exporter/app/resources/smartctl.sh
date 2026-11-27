#!/bin/sh
# smartctl-exporter hard-codes `--log=error`, the ATA summary error log. Some drives (osd.1's
# ESSENCORE) leave that log empty and record errors only in the extended log, so also read
# `--log=xerror`: the exporter then emits smartctl_device_error_log_count{error_log_type="extended"}.
# The extra flag sets exit-status bit 6 when the log has entries, which the exporter only warns on.
# Device scans take no log options.
case " $* " in
  *" --scan "*) exec /usr/sbin/smartctl "$@" ;;
esac
exec /usr/sbin/smartctl --log=xerror "$@"
