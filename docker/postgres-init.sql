-- Runs once when the Postgres volume is first created. Ali CT uses the default
-- database; Orthanc keeps its DICOM index in a separate one on the same server.
CREATE DATABASE orthanc;
