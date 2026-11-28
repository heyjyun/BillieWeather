require "timeout"

module Finance
  class StatementWorkbook
    # The shared XLSX decoder enforces inflated-size, cell, sheet and XML limits.
    # Use files for both streams so child termination and pipe backpressure cannot deadlock.
    def self.csv(bytes)
      Tempfile.create(["billie-workbook", ".xlsx"], binmode: true) do |input|
        Tempfile.create(["billie-sheet", ".csv"], binmode: true) do |output|
          input.write(bytes)
          input.rewind
          pid = Process.spawn("node", "--max-old-space-size=128", Rails.root.join("lib/finance/statement-workbook.mjs").to_s,
            in: input, out: output, err: File::NULL, unsetenv_others: true, close_others: true)
          begin
            _, status = Timeout.timeout(8) { Process.wait2(pid) }
          rescue Timeout::Error
            Process.kill("KILL", pid) rescue nil
            Process.wait(pid) rescue nil
            raise StatementImporter::ImportError, I18n.t("billie.backend.csv_unreadable")
          end
          raise StatementImporter::ImportError, I18n.t("billie.backend.csv_unreadable") unless status.success? && output.size <= StatementImporter::MAX_BYTES
          output.rewind
          output.read
        end
      end
    rescue Errno::ENOENT
      raise StatementImporter::ImportError, I18n.t("billie.backend.csv_unreadable")
    end
  end
end
