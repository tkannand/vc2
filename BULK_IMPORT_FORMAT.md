# Bulk Import - Expected Data Format

## File

- **File name:** `new users.xlsx`
- **Location:** Project root (`vc2/`)
- **Sheet name:** `Sheet1`
- **First row:** Header (skipped during import)

## Required Columns

| Column | Header       | Description                          | Example            |
|--------|-------------|--------------------------------------|--------------------|
| A      | S.NO        | Serial number (ignored)              | 1                  |
| B      | Name        | Full name of the booth worker        | P.Karthik          |
| C      | PHONE       | Phone number with or without +91     | +919629417519      |
| F      | Ward        | Ward name                            | WARD 23            |
| G      | Booth       | Booth identifier                     | Booth # 001        |

## Ignored Columns

| Column | Header       | Description                          |
|--------|-------------|--------------------------------------|
| D      | Voter ID    | Not used during import               |
| E      | People Role | Not used during import               |
| H      | Division    | Not used during import               |

## Phone Number Rules

- Can include `+91` prefix (stripped automatically)
- Can include spaces (stripped automatically)
- Must be a valid 10-digit Indian mobile number after cleaning
- Rows with missing or invalid phone numbers are skipped

## Other Notes

- All imported users are assigned the role `booth`
- If a phone number already exists in the system, the user's name, ward, and booth are updated
- If the phone number is new, a new user is created
- Rows where both Name and Phone are empty are treated as end of data
- A summary of added, updated, and errored rows is printed at the end

## Usage

```
python bulk_import_users.py
```
