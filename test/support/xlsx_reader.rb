require "zip"
require "nokogiri"
require "stringio"

# Reads an .xlsx produced in a test back into plain Ruby values, so tests can check
# what a spreadsheet app would actually show. Strings come back as String, numbers as
# Float, and `formulas` lists every <f> element (there should never be any).
class XlsxReader
  attr_reader :sheet_names, :formulas

  def initialize(binary)
    @files = {}
    Zip::InputStream.open(StringIO.new(binary)) do |zip|
      while (entry = zip.get_next_entry)
        @files[entry.name] = zip.read
      end
    end
    @shared = xml("xl/sharedStrings.xml")&.xpath("//xmlns:si")&.map { |si| si.xpath(".//xmlns:t").map(&:text).join } || []
    workbook = xml("xl/workbook.xml")
    rels = xml("xl/_rels/workbook.xml.rels").xpath("//xmlns:Relationship").to_h { |rel| [rel["Id"], rel["Target"]] }
    @sheets = workbook.xpath("//xmlns:sheet").to_h do |sheet|
      [sheet["name"], "xl/#{rels.fetch(sheet["r:id"]).delete_prefix("/xl/")}"]
    end
    @sheet_names = @sheets.keys
    @formulas = @files.select { |name, _| name.start_with?("xl/worksheets/") }.flat_map { |_, body| Nokogiri::XML(body).xpath("//xmlns:f").map(&:text) }
  end

  # Rows of the named sheet as arrays of cell values (nil for empty cells).
  def rows(sheet_name)
    doc = Nokogiri::XML(@files.fetch(@sheets.fetch(sheet_name)))
    doc.xpath("//xmlns:sheetData/xmlns:row").map do |row|
      row.xpath("xmlns:c").each_with_object([]) do |cell, values|
        column = cell["r"][/\A[A-Z]+/].chars.reduce(0) { |sum, char| sum * 26 + char.ord - 64 } - 1
        values[column] = value_of(cell)
      end
    end
  end

  # The value next to a label in the first column of a sheet.
  def lookup(sheet_name, label)
    rows(sheet_name).find { |row| row[0] == label }&.at(1)
  end

  private

  def xml(name)
    @files[name] && Nokogiri::XML(@files[name])
  end

  def value_of(cell)
    case cell["t"]
    when "s" then @shared[cell.at_xpath("xmlns:v").text.to_i]
    when "inlineStr" then cell.xpath(".//xmlns:t").map(&:text).join
    when "str" then cell.at_xpath("xmlns:v")&.text
    when "b" then cell.at_xpath("xmlns:v")&.text == "1"
    else
      value = cell.at_xpath("xmlns:v")&.text
      value && Float(value)
    end
  end
end
