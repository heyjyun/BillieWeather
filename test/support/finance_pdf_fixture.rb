# A small, valid PDF builder for parser and HTTP upload tests. No PDF-writing
# dependency, original financial records, or generated binary fixture is needed.
module FinancePdfFixture
  def finance_statement_pdf(lines, pages: 1)
    page_ids = pages.times.map { |index| 4 + index * 2 }
    objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [#{page_ids.map { |id| "#{id} 0 R" }.join(" ")}] /Count #{pages} >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ]
    pages.times do |index|
      page_id = page_ids[index]
      content_id = page_id + 1
      content = +"BT\n/F1 10 Tf\n40 750 Td\n14 TL\n"
      lines.each do |line|
        escaped = line.gsub(/[\\()]/) { |character| "\\#{character}" }
        content << "(#{escaped}) Tj\nT*\n"
      end
      content << "ET\n"
      objects << "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents #{content_id} 0 R >>"
      objects << "<< /Length #{content.bytesize} >>\nstream\n#{content}endstream"
    end
    pdf = +"%PDF-1.4\n"
    offsets = [0]
    objects.each_with_index do |body, index|
      offsets << pdf.bytesize
      pdf << "#{index + 1} 0 obj\n#{body}\nendobj\n"
    end
    xref_offset = pdf.bytesize
    pdf << "xref\n0 #{objects.length + 1}\n0000000000 65535 f \n"
    offsets.drop(1).each { |offset| pdf << format("%010d 00000 n \n", offset) }
    pdf << "trailer\n<< /Size #{objects.length + 1} /Root 1 0 R >>\nstartxref\n#{xref_offset}\n%%EOF\n"
    pdf.b
  end
end
